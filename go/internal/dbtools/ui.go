package dbtools

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
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

// clickhouseUIScript runs in ImageClickHouseUI: an nginx in front of the
// server's HTTP interface that opens the Play page on "/" and signs every
// request in as the admin with a Basic header it sets itself. Whatever a
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

// uiTarget builds the helper for a database: image, sign-in env and port.
// sessionSecrets sign mongo-express cookies. They are made once per agent
// run: new ones on every wake would change the spec hash and recreate the
// container each time.
func uiTarget(spec *agentv1.ServiceSpec, sessionSecrets [2]string) (jobrun.Target, error) {
	db := spec.GetDatabase()
	if spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE || db == nil {
		return jobrun.Target{}, ErrNotFound
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
	switch e := db.GetEngine(); {
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:
		u := url.URL{Scheme: "postgres", User: url.UserPassword(c.GetAdminUser(), c.GetAdminPassword()),
			Host: host + ":" + ps, Path: "/" + c.GetDatabase(), RawQuery: "sslmode=disable"}
		s.Image = ImagePgweb
		s.Env = []string{"PGWEB_DATABASE_URL=" + u.String(), "DATABASE_URL=" + u.String()}
		s.Cmd = []string{"/usr/bin/pgweb", "--bind=0.0.0.0", "--listen=8081", "--lock-session", "--skip-open"}
		t.Port = 8081
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL, e == agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
		// PMA_USER and PMA_PASSWORD switch phpMyAdmin to config auth: it
		// signs in by itself.
		s.Image = ImagePhpMyAdmin
		s.Env = []string{"PMA_HOST=" + host, "PMA_PORT=" + ps, "PMA_USER=" + c.GetAdminUser(), "PMA_PASSWORD=" + c.GetAdminPassword()}
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
			// The edge ticket is the login.
			"ME_CONFIG_BASICAUTH=false",
			"ME_CONFIG_BASICAUTH_ENABLED=false",
			"ME_CONFIG_SITE_COOKIESECRET=" + sessionSecrets[0],
			"ME_CONFIG_SITE_SESSIONSECRET=" + sessionSecrets[1],
		}
		t.Port = 8081
	case dbengine.RedisLike(e):
		// Redis Commander speaks to Valkey, KeyDB and Dragonfly as to Redis.
		s.Image = ImageRedisCmdr
		s.Env = []string{"REDIS_HOST=" + host, "REDIS_PORT=" + ps, "REDIS_PASSWORD=" + c.GetAdminPassword()}
		if u := c.GetAdminUser(); u != "" && u != "default" {
			s.Env = append(s.Env, "REDIS_USERNAME="+u)
		}
		t.Port = 8081
	case e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
		auth := base64.StdEncoding.EncodeToString([]byte(c.GetAdminUser() + ":" + c.GetAdminPassword()))
		s.Image = ImageClickHouseUI
		s.Entrypoint = []string{"/bin/sh", "-c"}
		s.Cmd = []string{clickhouseUIScript}
		s.Env = []string{"CH_HOST=" + host, "CH_PORT=" + strconv.FormatUint(uint64(dbengine.HTTPPort(e)), 10), "CH_AUTH=" + auth}
		t.Port = 8080
	default:
		return jobrun.Target{}, fmt.Errorf("%w: unknown engine %v", ErrNotFound, db.GetEngine())
	}
	t.Spec = s
	return t, nil
}

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
	demand  *jobrun.OnDemand
	log     *slog.Logger
	secrets [2]string

	mu    sync.Mutex
	specs map[string]*agentv1.ServiceSpec
}

var _ Manager = (*UIs)(nil)

// NewUIs returns a manager running UIs through demand.
func NewUIs(demand *jobrun.OnDemand, logger *slog.Logger) *UIs {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &UIs{demand: demand, log: logger, secrets: [2]string{randomHex(), randomHex()}, specs: map[string]*agentv1.ServiceSpec{}}
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
	t, err := uiTarget(spec, u.secrets)
	if err != nil {
		return "", err
	}
	return u.demand.Wake(ctx, t)
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
