package dbtools

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
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
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS,
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

func TestUITargets(t *testing.T) {
	want := map[agentv1.DatabaseEngine]struct {
		image string
		port  uint32
		env   string
	}{
		agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES: {ImagePgweb, 8081, "DATABASE_URL=postgres://admin:p%40ss%3Aw%2Frd@db:5432/app?sslmode=disable"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL:    {ImagePhpMyAdmin, 80, "PMA_USER=admin"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB:  {ImagePhpMyAdmin, 80, "PMA_PORT=3306"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO:    {ImageMongoExpress, 8081, "ME_CONFIG_MONGODB_URL=mongodb://admin:p%40ss%3Aw%2Frd@db:27017/?authSource=admin"},
		agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS:    {ImageRedisCmdr, 8081, "REDIS_PASSWORD=p@ss:w/rd"},
	}
	for e, w := range want {
		tg, err := uiTarget(dbSpec("db1", e, true), [2]string{"a", "b"})
		if err != nil {
			t.Fatal(err)
		}
		if tg.Spec.Image != w.image || tg.Port != w.port || !slices.Contains(tg.Spec.Env, w.env) {
			t.Errorf("%v: target %+v", e, tg)
		}
		if tg.Spec.Name != "seylo-db1-db-ui" || tg.Network != docker.ProjectNetwork("p1") || tg.Spec.Labels[docker.LabelRole] != jobrun.RoleDBUI || tg.Idle != DefaultIdle {
			t.Errorf("%v: target %+v", e, tg)
		}
	}
	if _, err := uiTarget(&agentv1.ServiceSpec{Id: "x", Kind: agentv1.ServiceKind_SERVICE_KIND_APP}, [2]string{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("app accepted")
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
	db := dbSpec("d", agentv1.DatabaseEngine_DATABASE_ENGINE_REDIS, false).GetDatabase()
	db.Exposure = &agentv1.DatabaseExposure{Enabled: true, User: "u", Password: "p"}
	if _, err := exposedUserJob(db, nil); err == nil {
		t.Error("redis got an exposed user job")
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
