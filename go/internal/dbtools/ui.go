package dbtools

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbengine"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Manager wakes database web UIs for the edge.
type Manager interface {
	// Wake starts the UI of a database service if needed and returns the
	// base URL the edge proxies to, for example "http://172.18.0.5:8081".
	// It returns ErrNotFound when the service is not a database on this
	// node or its web UI is turned off.
	Wake(ctx context.Context, serviceID string) (upstream string, err error)
	// Touch records activity so the idle stop does not hit an open session.
	Touch(serviceID string)
}

// ErrNotFound means there is no web UI to open for the service here.
var ErrNotFound = errors.New("no database web UI for this service on this node")

// DefaultIdle stops a UI after this long without traffic.
const DefaultIdle = 15 * time.Minute

// UI images, pinned. The agent picks them by engine; the panel sends none.
// ClickHouse needs no UI image of its own: its server serves the Play page
// on the HTTP port, and ImageClickHouseUI is only the proxy that signs it
// in (clickhouseUIScript).
const (
	ImagePgweb        = "sosedoff/pgweb:0.17.0"
	ImagePhpMyAdmin   = "phpmyadmin:5.2.3"
	ImageMongoExpress = "mongo-express:1.0.2-20-alpine3.19"
	ImageRedisCmdr    = "ghcr.io/joeferner/redis-commander:0.9.1"
	ImageClickHouseUI = "nginx:1.30.6-alpine"
)

// The helpers run on the project's network, next to every other service
// of the project, with the admin's credentials. So none of them is open:
// each asks for a login of its own (helperLogin), which only the edge has
// and sets on every request it proxies (Authorization, replacing the
// browser's), so a container of the project that reaches the helper gets
// 401, and the edge ticket stays the only way in for people. The login is
// random per agent run (a restart recreates the helper on its next wake);
// phpMyAdmin asks for the database's admin login itself (HTTP auth).

// helperLogin is the user name of a helper's own login.
const helperLogin = "seylo"

// clickhouseUIScript runs in ImageClickHouseUI: an nginx in front of the
// server's HTTP interface that opens the Play page on "/", refuses any
// request without the helper's login (UI_AUTH, which the edge sends) and
// signs every other request in as the admin with a Basic header it sets
// itself. Whatever a
// browser sends as Authorization or X-ClickHouse-User/-Key is replaced or
// dropped, and a request with credential URL parameters (user, password,
// quota_key, which ClickHouse prefers over the header) or a percent-encoded
// parameter name (which could spell one) is refused, so the password never
// reaches the browser and the edge ticket stays the only login. Play adds
// those parameters only when someone fills its user or password field. The
// upstream is resolved through Docker's DNS on each request, so a
// recreated database container is found again.
var clickhouseUIScript = strings.Replace(clickhouseUITemplate, "@CREDENTIAL_ARGS@", strings.ReplaceAll(clickhouseCredentialArgs, "$", `\$`), 1)

// clickhouseCredentialArgs matches (case-insensitively, as nginx's ~*) a
// query string that carries ClickHouse credentials or a percent-encoded
// parameter name.
const clickhouseCredentialArgs = `(^|&)((user|password|quota_key)(=|&|$)|[^=&]*%)`

const clickhouseUITemplate = `set -e
cat > /etc/nginx/conf.d/default.conf <<EOF
resolver 127.0.0.11 valid=10s ipv6=off;
server {
  listen 8080;
  client_max_body_size 64m;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 1h;
  proxy_set_header Authorization "Basic $CH_AUTH";
  proxy_set_header X-ClickHouse-User "";
  proxy_set_header X-ClickHouse-Key "";
  proxy_set_header Cookie "";
  if (\$http_authorization != "Basic $UI_AUTH") { return 401; }
  if (\$args ~* "@CREDENTIAL_ARGS@") { return 403; }
  set \$upstream http://$CH_HOST:$CH_PORT;
  location = / {
    if (\$args = "") { return 302 /play; }
    proxy_pass \$upstream;
  }
  location / {
    proxy_pass \$upstream;
  }
}
EOF
exec nginx -g 'daemon off;'
`

// uiName is the helper container of a database's UI.
func uiName(serviceID string) string { return jobrun.HelperName(serviceID, "db-ui") }

// uiKeys are the random values of one agent run: new ones on every wake
// would change the spec hash and recreate the container each time.
type uiKeys struct {
	// cookie and session sign mongo-express cookies.
	cookie, session string
	// login is the helper's own password (helperLogin).
	login string
	// jwt is Redis Commander's token secret.
	jwt string
}

func newUIKeys() uiKeys {
	return uiKeys{cookie: randomHex(), session: randomHex(), login: randomHex(), jwt: randomHex()}
}

// basic is an Authorization header value.
func basic(user, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
}

// redisCommanderToken is a session token Redis Commander takes from its
// Authorization header: HS256 with its jwtSecret, its own issuer and
// subject. Made for each request, valid for 10 minutes.
func redisCommanderToken(secret string, now time.Time) string {
	enc := base64.RawURLEncoding
	body, _ := json.Marshal(map[string]any{"iss": "Redis Commander", "sub": "Session Token", "iat": now.Unix(), "exp": now.Add(10 * time.Minute).Unix()})
	msg := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return msg + "." + enc.EncodeToString(mac.Sum(nil))
}

// uiTarget builds the helper for a database (image, sign-in env and port)
// and the Authorization value the edge sends it.
func uiTarget(spec *agentv1.ServiceSpec, keys uiKeys) (jobrun.Target, func(time.Time) string, error) {
	db := spec.GetDatabase()
	if spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE || db == nil {
		return jobrun.Target{}, nil, ErrNotFound
	}
	c := db.GetCredentials()
	host := spec.GetName()
	port := enginePort(spec)
	ps := strconv.FormatUint(uint64(port), 10)
	t := jobrun.Target{Network: jobrun.ProjectNetwork(spec), Idle: DefaultIdle}
	if d := db.GetTools().GetWebUiIdleTimeout(); d != nil && d.AsDuration() > 0 {
		t.Idle = d.AsDuration()
	}
	s := jobrun.Spec{
		Name:     uiName(spec.GetId()),
		Labels:   jobrun.Labels(jobrun.OwnerOf(spec), jobrun.RoleDBUI, nil),
		Network:  t.Network,
		KeepLogs: true,
	}
	login := basic(helperLogin, keys.login)
	auth := func(time.Time) string { return login }
	switch e := db.GetEngine(); {
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		u := url.URL{Scheme: "postgres", User: url.UserPassword(c.GetAdminUser(), c.GetAdminPassword()),
			Host: host + ":" + ps, Path: "/" + c.GetDatabase(), RawQuery: "sslmode=disable"}
		s.Image = ImagePgweb
		s.Env = []string{"PGWEB_DATABASE_URL=" + u.String(), "DATABASE_URL=" + u.String(),
			"PGWEB_AUTH_USER=" + helperLogin, "PGWEB_AUTH_PASS=" + keys.login}
		s.Cmd = []string{"/usr/bin/pgweb", "--bind=0.0.0.0", "--listen=8081", "--lock-session", "--skip-open"}
		t.Port = 8081
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, e == agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		// HTTP auth: phpMyAdmin signs in to the server with the login of
		// the request, which the edge sets to the admin's.
		s.Image = ImagePhpMyAdmin
		s.Env = []string{"PMA_HOST=" + host, "PMA_PORT=" + ps, "PMA_USER_CONFIG_BASE64=" + base64.StdEncoding.EncodeToString([]byte(phpMyAdminConfig))}
		admin := basic(c.GetAdminUser(), c.GetAdminPassword())
		auth = func(time.Time) string { return admin }
		t.Port = 80
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:
		u := url.URL{Scheme: "mongodb", Host: host + ":" + ps, Path: "/"}
		if c.GetAdminUser() != "" {
			u.User = url.UserPassword(c.GetAdminUser(), c.GetAdminPassword())
			u.RawQuery = "authSource=admin"
		}
		s.Image = ImageMongoExpress
		s.Env = []string{
			"ME_CONFIG_MONGODB_URL=" + u.String(),
			"ME_CONFIG_MONGODB_ENABLE_ADMIN=true",
			"ME_CONFIG_BASICAUTH=true",
			"ME_CONFIG_BASICAUTH_ENABLED=true",
			"ME_CONFIG_BASICAUTH_USERNAME=" + helperLogin,
			"ME_CONFIG_BASICAUTH_PASSWORD=" + keys.login,
			"ME_CONFIG_SITE_COOKIESECRET=" + keys.cookie,
			"ME_CONFIG_SITE_SESSIONSECRET=" + keys.session,
		}
		t.Port = 8081
	case dbengine.RedisLike(e):
		// Redis Commander speaks to Valkey, KeyDB and Dragonfly as to Redis.
		// With a login set it wants a session token on every request; the
		// edge makes them with the token secret set here (NODE_CONFIG).
		s.Image = ImageRedisCmdr
		jwtConfig, _ := json.Marshal(map[string]any{"server": map[string]any{"httpAuth": map[string]string{"jwtSecret": keys.jwt}}})
		s.Env = []string{"REDIS_HOST=" + host, "REDIS_PORT=" + ps, "REDIS_PASSWORD=" + c.GetAdminPassword(),
			"HTTP_USER=" + helperLogin, "HTTP_PASSWORD=" + keys.login, "NODE_CONFIG=" + string(jwtConfig)}
		if u := c.GetAdminUser(); u != "" && u != "default" {
			s.Env = append(s.Env, "REDIS_USERNAME="+u)
		}
		secret := keys.jwt
		auth = func(now time.Time) string { return "Bearer " + redisCommanderToken(secret, now) }
		t.Port = 8081
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		admin := base64.StdEncoding.EncodeToString([]byte(c.GetAdminUser() + ":" + c.GetAdminPassword()))
		s.Image = ImageClickHouseUI
		s.Entrypoint = []string{"/bin/sh", "-c"}
		s.Cmd = []string{clickhouseUIScript}
		s.Env = []string{"CH_HOST=" + host, "CH_PORT=" + strconv.FormatUint(uint64(dbengine.HTTPPort(e)), 10), "CH_AUTH=" + admin,
			"UI_AUTH=" + strings.TrimPrefix(login, "Basic ")}
		t.Port = 8080
	default:
		return jobrun.Target{}, nil, fmt.Errorf("%w: unknown engine %v", ErrNotFound, db.GetEngine())
	}
	t.Spec = s
	return t, auth, nil
}

// phpMyAdminConfig is config.user.inc.php: HTTP auth on the one server.
const phpMyAdminConfig = "<?php\n$cfg['Servers'][1]['auth_type'] = 'http';\n"

func enginePort(spec *agentv1.ServiceSpec) uint32 {
	if ps := spec.GetPorts(); len(ps) > 0 && ps[0].GetContainerPort() != 0 {
		return ps[0].GetContainerPort()
	}
	return dbengine.Port(spec.GetDatabase().GetEngine())
}

func randomHex() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand: %v", err))
	}
	return hex.EncodeToString(b[:])
}

// UIs is the Manager: it follows the desired state and runs the UIs on
// a jobrun.OnDemand.
type UIs struct {
	demand *jobrun.OnDemand
	log    *slog.Logger
	keys   uiKeys
	// Now is the clock for Redis Commander's tokens; default time.Now.
	Now func() time.Time

	mu    sync.Mutex
	specs map[string]*agentv1.ServiceSpec
}

var _ Manager = (*UIs)(nil)

// NewUIs returns a manager running UIs through demand.
func NewUIs(demand *jobrun.OnDemand, logger *slog.Logger) *UIs {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &UIs{demand: demand, log: logger, keys: newUIKeys(), Now: time.Now, specs: map[string]*agentv1.ServiceSpec{}}
}

// Sync takes the database services of the desired state. UIs of services
// that left or turned the UI off are stopped.
func (u *UIs) Sync(ctx context.Context, specs []*agentv1.ServiceSpec) {
	next := map[string]*agentv1.ServiceSpec{}
	for _, s := range specs {
		if s.GetKind() == agentv1.ServiceKind_SERVICE_KIND_DATABASE && s.GetDatabase().GetTools().GetWebUi() && !s.GetStopped() {
			next[s.GetId()] = s
		}
	}
	u.mu.Lock()
	var gone []string
	for id := range u.specs {
		if next[id] == nil {
			gone = append(gone, id)
		}
	}
	u.specs = next
	u.mu.Unlock()
	for _, id := range gone {
		if running, _ := u.demand.State(uiName(id)); running {
			if err := u.demand.Sleep(ctx, uiName(id)); err != nil {
				u.log.Warn("stopping database web UI", "service_id", id, "err", err)
			}
		}
	}
}

// Wake implements Manager.
func (u *UIs) Wake(ctx context.Context, serviceID string) (string, error) {
	u.mu.Lock()
	spec := u.specs[serviceID]
	u.mu.Unlock()
	if spec == nil {
		return "", ErrNotFound
	}
	t, _, err := uiTarget(spec, u.keys)
	if err != nil {
		return "", err
	}
	return u.demand.Wake(ctx, t)
}

// Authorization is the Authorization header the edge sends with every
// request to a database's UI (the helper's own login), "" when there is
// no UI for the service.
func (u *UIs) Authorization(serviceID string) string {
	u.mu.Lock()
	spec := u.specs[serviceID]
	u.mu.Unlock()
	if spec == nil {
		return ""
	}
	_, auth, err := uiTarget(spec, u.keys)
	if err != nil {
		return ""
	}
	return auth(u.Now())
}

// Touch implements Manager.
func (u *UIs) Touch(serviceID string) { u.demand.Touch(uiName(serviceID)) }

// Status is the web UI's actual state for ServiceStatus.web_ui, nil when
// the service has no web UI here.
func (u *UIs) Status(serviceID string) *agentv1.ToolStatus {
	u.mu.Lock()
	_, ok := u.specs[serviceID]
	u.mu.Unlock()
	if !ok {
		return nil
	}
	running, started, last := u.demand.Info(uiName(serviceID))
	st := &agentv1.ToolStatus{Running: running}
	if running {
		st.StartedAt = timestamppb.New(started)
		st.LastActiveAt = timestamppb.New(last)
	}
	return st
}

// ServiceOf returns the service id of a web UI helper container name, or
// "" when name is not one.
func (u *UIs) ServiceOf(name string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	for id := range u.specs {
		if uiName(id) == name {
			return id
		}
	}
	return ""
}
