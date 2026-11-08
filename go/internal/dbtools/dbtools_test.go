package dbtools

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbengine"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

func dbSpec(id string, engine agentv1.DatabaseEngine, webUI bool) *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: id, ProjectId: "p1", Name: "db", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{
			Engine:      engine,
			Credentials: &agentv1.DatabaseCredentials{AdminUser: "admin", AdminPassword: "p@ss:w/rd", Database: "app"},
			Tools:       &agentv1.DatabaseTools{WebUi: webUI},
		}},
	}
}

func TestClientCommandKeepsPasswordOutOfArgv(t *testing.T) {
	for _, e := range []agentv1.DatabaseEngine{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL,
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO,
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY,
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE,
	} {
		argv, env, err := ClientCommand(dbSpec("d", e, false).GetDatabase())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.Join(argv, " "), "p@ss") {
			t.Errorf("%v: password in argv %v", e, argv)
		}
		if !slices.ContainsFunc(env, func(s string) bool { return strings.HasSuffix(s, "=p@ss:w/rd") }) {
			t.Errorf("%v: password not in env %v", e, env)
		}
	}
	if _, _, err := ClientCommand(nil); !errors.Is(err, ErrNoDatabase) {
		t.Fatal("nil spec accepted")
	}
}

// Each engine opens its own image's client, signed in to the default
// database where it has one.
func TestClientCommandPerEngine(t *testing.T) {
	want := map[agentv1.DatabaseEngine]string{
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:      "redis-cli -h 127.0.0.1 --no-auth-warning --user admin",
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:     "valkey-cli -h 127.0.0.1 --no-auth-warning --user admin",
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:      "keydb-cli -h 127.0.0.1 --no-auth-warning --user admin",
		agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY:  "redis-cli -h 127.0.0.1 --no-auth-warning --user admin",
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE: "clickhouse-client --host=127.0.0.1 --user=admin --database=app",
	}
	for e, w := range want {
		argv, env, err := ClientCommand(dbSpec("d", e, false).GetDatabase())
		if err != nil || strings.Join(argv, " ") != w {
			t.Errorf("%v: argv %q, %v", e, argv, err)
		}
		key := "REDISCLI_AUTH="
		if e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE {
			key = "CLICKHOUSE_PASSWORD="
		}
		if !slices.Equal(env, []string{key + "p@ss:w/rd"}) {
			t.Errorf("%v: env %v", e, env)
		}
	}
	// The default user is implied on Redis-like engines.
	db := dbSpec("d", agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY, false).GetDatabase()
	db.Credentials.AdminUser = "default"
	if argv, _, _ := ClientCommand(db); slices.Contains(argv, "--user") {
		t.Errorf("default user named: %v", argv)
	}
	if _, _, err := ClientCommand(dbSpec("d", agentv1.DatabaseEngine(99), false).GetDatabase()); !errors.Is(err, ErrNoDatabase) {
		t.Errorf("unknown engine err = %v", err)
	}
}

func TestUITargets(t *testing.T) {
	want := map[agentv1.DatabaseEngine]struct {
		image string
		port  uint32
		env   string
	}{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES:  {ImagePgweb, 8081, "DATABASE_URL=postgres://admin:p%40ss%3Aw%2Frd@db:5432/app?sslmode=disable"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL:     {ImagePhpMyAdmin, 80, "PMA_HOST=db"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:   {ImagePhpMyAdmin, 80, "PMA_PORT=3306"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:     {ImageMongoExpress, 8081, "ME_CONFIG_MONGODB_URL=mongodb://admin:p%40ss%3Aw%2Frd@db:27017/?authSource=admin"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:     {ImageRedisCmdr, 8081, "REDIS_PASSWORD=p@ss:w/rd"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY:    {ImageRedisCmdr, 8081, "REDIS_HOST=db"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB:     {ImageRedisCmdr, 8081, "REDIS_PORT=6379"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY: {ImageRedisCmdr, 8081, "REDIS_PASSWORD=p@ss:w/rd"},
		// The Play page through nginx on the HTTP port, signed in with a Basic header of admin:p@ss:w/rd.
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE: {ImageClickHouseUI, 8080, "CH_AUTH=YWRtaW46cEBzczp3L3Jk"},
	}
	keys := uiKeys{cookie: "a", session: "b", login: "l0g1n", jwt: "jwt-secret"}
	now := time.Unix(1_800_000_000, 0)
	for e, w := range want {
		tg, auth, err := uiTarget(dbSpec("db1", e, true), keys)
		if err != nil {
			t.Fatal(err)
		}
		// No helper is open: each has a login only the edge sends.
		got := auth(now)
		switch {
		case e == agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL || e == agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:
			// phpMyAdmin's HTTP auth: the admin's own login, no auto sign-in.
			if got != basic("admin", "p@ss:w/rd") || slices.ContainsFunc(tg.Spec.Env, func(v string) bool { return strings.HasPrefix(v, "PMA_USER=") }) {
				t.Errorf("%v: auth %q env %v", e, got, tg.Spec.Env)
			}
		case dbengine.RedisLike(e):
			if got != "Bearer "+redisCommanderToken("jwt-secret", now) || !slices.Contains(tg.Spec.Env, "HTTP_PASSWORD=l0g1n") ||
				!slices.Contains(tg.Spec.Env, `NODE_CONFIG={"server":{"httpAuth":{"jwtSecret":"jwt-secret"}}}`) {
				t.Errorf("%v: auth %q env %v", e, got, tg.Spec.Env)
			}
		case e == agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE:
			if got != basic(helperLogin, "l0g1n") || !slices.Contains(tg.Spec.Env, "UI_AUTH="+strings.TrimPrefix(got, "Basic ")) {
				t.Errorf("%v: auth %q env %v", e, got, tg.Spec.Env)
			}
		default:
			if got != basic(helperLogin, "l0g1n") || !strings.Contains(strings.Join(tg.Spec.Env, " "), "l0g1n") {
				t.Errorf("%v: auth %q env %v", e, got, tg.Spec.Env)
			}
		}
		if slices.Contains(tg.Spec.Env, "ME_CONFIG_BASICAUTH=false") {
			t.Errorf("%v: mongo-express without its login", e)
		}
		if tg.Spec.Image != w.image || tg.Port != w.port || !slices.Contains(tg.Spec.Env, w.env) {
			t.Errorf("%v: target %+v", e, tg)
		}
		if tg.Spec.Name != "seylo-db1-db-ui" || tg.Network != docker.ProjectNetwork("p1") || tg.Spec.Labels[docker.LabelRole] != jobrun.RoleDBUI || tg.Idle != DefaultIdle {
			t.Errorf("%v: target %+v", e, tg)
		}
	}
	if _, _, err := uiTarget(&agentv1.ServiceSpec{Id: "x", Kind: agentv1.ServiceKind_SERVICE_KIND_APP}, uiKeys{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("app accepted")
	}
	// ClickHouse: the HTTP port, not the native one the spec lists first,
	// and the password only inside the Basic header.
	ch := dbSpec("db1", agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE, true)
	ch.Ports = []*agentv1.PortSpec{{ContainerPort: 9000}, {ContainerPort: 8123}}
	tg, _, err := uiTarget(ch, uiKeys{login: "l0g1n"})
	if err != nil || !slices.Contains(tg.Spec.Env, "CH_PORT=8123") || !slices.Contains(tg.Spec.Env, "CH_HOST=db") {
		t.Fatalf("clickhouse target %+v, %v", tg, err)
	}
	if strings.Contains(strings.Join(tg.Spec.Env, " ")+strings.Join(tg.Spec.Cmd, " "), "p@ss") {
		t.Fatal("clickhouse password in clear")
	}
}

// Redis Commander's session tokens: HS256 over its issuer and subject,
// valid for 10 minutes, signed with the secret the helper was given.
func TestRedisCommanderToken(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tok := redisCommanderToken("s3cret", now)
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token %q", tok)
	}
	head, _ := base64.RawURLEncoding.DecodeString(parts[0])
	body, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if string(head) != `{"alg":"HS256","typ":"JWT"}` || string(body) != `{"exp":1800000600,"iat":1800000000,"iss":"Redis Commander","sub":"Session Token"}` {
		t.Fatalf("head %s body %s", head, body)
	}
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
		t.Fatal("signature does not match")
	}
}

// The ClickHouse UI proxy refuses requests without the helper's login,
// whatever else they carry.
func TestClickHouseUIRequiresItsLogin(t *testing.T) {
	if !strings.Contains(clickhouseUIScript, `if (\$http_authorization != "Basic $UI_AUTH") { return 401; }`) {
		t.Fatalf("script = %s", clickhouseUIScript)
	}
}

// The ClickHouse UI proxy refuses credentials as URL parameters (they win
// over its Basic header) and percent-encoded parameter names; Play's own
// parameters pass. The pattern reaches nginx with $ escaped for the shell.
func TestClickHouseUIRefusesCredentialArgs(t *testing.T) {
	if !strings.Contains(clickhouseUIScript, `if (\$args ~* "(^|&)((user|password|quota_key)(=|&|\$)|[^=&]*%)") { return 403; }`) {
		t.Fatalf("script = %s", clickhouseUIScript)
	}
	re := regexp.MustCompile("(?i)" + clickhouseCredentialArgs)
	for args, refused := range map[string]bool{
		"user=nobody":        true,
		"a=1&password=x":     true,
		"USER=x":             true,
		"user":               true,
		"x=1&quota_key=k":    true,
		"%75ser=nobody":      true,
		"a=1&p%61ssword=x":   true,
		"":                   false,
		"default_format=TSV": false,
		"param_user=1":       false,
		"username=1":         false,
		"q=user%3Dx":         false,
		"add_http_cors_header=1&default_format=JSONCompact&max_result_rows=1000": false,
	} {
		if got := re.MatchString(args); got != refused {
			t.Errorf("?%s refused = %v, want %v", args, got, refused)
		}
	}
}

func TestUIsOnlyServeEnabledDatabases(t *testing.T) {
	u := NewUIs(jobrun.NewOnDemand(nil, nil), nil)
	u.Sync(context.Background(), []*agentv1.ServiceSpec{
		dbSpec("off", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, false),
		{Id: "app", Kind: agentv1.ServiceKind_SERVICE_KIND_APP},
	})
	for _, id := range []string{"off", "app", "missing"} {
		if _, err := u.Wake(context.Background(), id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Wake(%s) err = %v", id, err)
		}
	}
}

func TestExposedUserJobKeepsSecretsInEnv(t *testing.T) {
	for _, e := range []agentv1.DatabaseEngine{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL,
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB, agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO,
		agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE,
	} {
		db := dbSpec("d", e, false).GetDatabase()
		db.Exposure = &agentv1.DatabaseExposure{Enabled: true, User: "remote", Password: "expo-secret"}
		j, err := exposedUserJob(db, &tlsMaterial{certPEM: []byte("CERT"), keyPEM: []byte("KEY")})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(j.env, "KEY_PEM=KEY") {
			t.Errorf("%v: key not in env", e)
		}
		all := strings.Join(j.argv, " ") + j.stdin
		if strings.Contains(all, "expo-secret") || strings.Contains(all, "p@ss") || strings.Contains(all, "remote") {
			t.Errorf("%v: values outside env: %q", e, all)
		}
		if !slices.Contains(j.env, "EXPOSED_PASSWORD=expo-secret") || !slices.Contains(j.env, "EXPOSED_USER=remote") {
			t.Errorf("%v: env = %v", e, j.env)
		}
	}
	for _, e := range []agentv1.DatabaseEngine{
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY,
	} {
		db := dbSpec("d", e, false).GetDatabase()
		db.Exposure = &agentv1.DatabaseExposure{Enabled: true, User: "u", Password: "p"}
		if _, err := exposedUserJob(db, nil); err == nil {
			t.Errorf("%v got an exposed user job", e)
		}
	}
	if _, err := exposedUserJob(dbSpec("d", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, false).GetDatabase(), nil); err == nil {
		t.Error("job without a user")
	}
	bad := dbSpec("d", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, false).GetDatabase()
	bad.Exposure = &agentv1.DatabaseExposure{Enabled: true, User: "x all all trust\nhost", Password: "p"}
	if _, err := exposedUserJob(bad, nil); err == nil {
		t.Error("user name that could inject pg_hba lines accepted")
	}
}

func TestCertForPrefersACMEAndKeepsSelfSigned(t *testing.T) {
	dir := t.TempDir()
	m1, err := certFor(nil, dir, "db1", "db.example.com")
	if err != nil || !m1.selfSigned {
		t.Fatalf("self-signed = %v, %v", m1.selfSigned, err)
	}
	block, _ := pem.Decode(m1.certPEM)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || cert.DNSNames[0] != "db.example.com" || cert.NotAfter.Before(time.Now().AddDate(9, 0, 0)) {
		t.Fatalf("cert = %v, %v", cert, err)
	}
	m2, _ := certFor(func(string) ([]byte, []byte, error) { return nil, nil, errors.New("none yet") }, dir, "db1", "db.example.com")
	if m2.fingerprint() != m1.fingerprint() {
		t.Fatal("self-signed certificate not reused")
	}
	acme, _ := certFor(func(h string) ([]byte, []byte, error) { return []byte("ACME " + h), []byte("K"), nil }, dir, "db1", "db.example.com")
	if acme.selfSigned || string(acme.certPEM) != "ACME db.example.com" {
		t.Fatalf("acme = %+v", acme)
	}
	if _, err := certFor(nil, dir, "../x", ""); err == nil {
		t.Fatal("bad service id accepted")
	}
}

// Only engines with a separate login get one; Redis-like engines are left
// to the portgate's TLS.
func TestExposedUsersSyncPicksEnginesWithAUser(t *testing.T) {
	x := NewExposedUsers(nil, nil, t.TempDir(), nil)
	var specs []*agentv1.ServiceSpec
	for _, e := range []agentv1.DatabaseEngine{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, agentv1.DatabaseEngine_DATABASE_ENGINE_CLICKHOUSE,
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, agentv1.DatabaseEngine_DATABASE_ENGINE_VALKEY,
		agentv1.DatabaseEngine_DATABASE_ENGINE_KEYDB, agentv1.DatabaseEngine_DATABASE_ENGINE_DRAGONFLY,
	} {
		s := dbSpec(e.String(), e, false)
		s.GetDatabase().Exposure = &agentv1.DatabaseExposure{Enabled: true, User: "external", Password: "p"}
		specs = append(specs, s)
	}
	x.Sync(specs)
	x.mu.Lock()
	defer x.mu.Unlock()
	if len(x.specs) != 2 || x.specs["DATABASE_ENGINE_POSTGRES"] == nil || x.specs["DATABASE_ENGINE_CLICKHOUSE"] == nil {
		t.Fatalf("specs = %v", x.specs)
	}
}
