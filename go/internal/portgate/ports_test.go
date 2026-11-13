package portgate

import (
	"context"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Timed exposes of one container port that end at the same moment are
// told apart by their TimedExpose id: each reports its own, with its own
// port (the panel matches its rows by it). Other ports report none.
func TestPortsReportTheTimedExposeID(t *testing.T) {
	expires := time.Now().Add(time.Hour)
	spec := &agentv1.ServiceSpec{
		Id:    "web1",
		Ports: []*agentv1.PortSpec{{ContainerPort: 3000, Public: &agentv1.PublicPort{}}},
		DevAccess: &agentv1.DevAccess{TimedExposes: []*agentv1.TimedExpose{
			{Id: "t1", ContainerPort: 3000, AllowedSourceCidrs: []string{"127.0.0.1/32"}, ExpiresAt: timestamppb.New(expires)},
			{Id: "t2", ContainerPort: 3000, AllowedSourceCidrs: []string{"127.0.0.1/32"}, ExpiresAt: timestamppb.New(expires)},
		}},
	}
	ls, errs := ListenersFor(spec)
	if len(errs) != 0 {
		t.Fatal(errs)
	}
	m := newManager(t, echoServer(t))
	ports, err := m.Sync(context.Background(), "web1", ls)
	if err != nil {
		t.Fatal(err)
	}
	if ports["expose-t1"] == ports["expose-t2"] {
		t.Fatalf("one port for two exposes: %v", ports)
	}
	byID := map[string]uint32{}
	for _, p := range m.Ports("web1") {
		if p.GetExpiresAt() == nil {
			if p.GetTimedExposeId() != "" {
				t.Fatalf("the public port reports a timed expose: %v", p)
			}
			continue
		}
		if !p.GetExpiresAt().AsTime().Equal(expires) {
			t.Fatalf("expiry %v, want %v", p.GetExpiresAt().AsTime(), expires)
		}
		byID[p.GetTimedExposeId()] = p.GetHostPort()
	}
	if len(byID) != 2 || byID["t1"] != ports["expose-t1"] || byID["t2"] != ports["expose-t2"] {
		t.Fatalf("reported %v, opened %v", byID, ports)
	}
}

// The exposed port of a Postgres or MySQL says whether TLS is on inside
// the database yet (SetDatabaseTLS, ExposedTLS.Applied on a node); a
// timed expose, a port the gate terminates, MariaDB (its own TLS) and a
// gate without the hook leave it unset.
func TestPortsReportTheDatabaseTLS(t *testing.T) {
	certPEM, keyPEM := testCert(t, "db.example.com", time.Now().Add(time.Hour))
	m := newManager(t, echoServer(t), func(c *Config) {
		c.Certificate = func(_, _ string) ([]byte, []byte, error) { return certPEM, keyPEM, nil }
	})
	sync := func(engine agentv1.DatabaseEngine) (database, timed *agentv1.OpenPort) {
		t.Helper()
		spec := &agentv1.ServiceSpec{Id: "d1", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
			DevAccess: &agentv1.DevAccess{TimedExposes: []*agentv1.TimedExpose{
				{Id: "t1", ContainerPort: DatabasePort(engine), AllowedSourceCidrs: []string{"127.0.0.1/32"}, ExpiresAt: timestamppb.New(time.Now().Add(time.Hour))},
			}},
			KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: engine,
				Exposure: &agentv1.DatabaseExposure{Enabled: true}}}}
		ls, errs := ListenersFor(spec)
		if len(errs) != 0 {
			t.Fatal(errs)
		}
		if _, err := m.Sync(context.Background(), "d1", ls); err != nil {
			t.Fatal(err)
		}
		for _, p := range m.Ports("d1") {
			if p.GetTimedExposeId() == "t1" {
				timed = p
			} else {
				database = p
			}
		}
		if database == nil || timed == nil {
			t.Fatalf("ports %v", m.Ports("d1"))
		}
		return database, timed
	}
	postgres := agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES
	if p, _ := sync(postgres); p.DatabaseTls != nil {
		t.Fatalf("reported without the hook: %v", p)
	}
	on := map[string]bool{}
	m.SetDatabaseTLS(func(id string) bool { return on[id] })
	p, timed := sync(postgres)
	if p.DatabaseTls == nil || p.GetDatabaseTls() {
		t.Fatalf("Postgres before TLS is on: %v", p)
	}
	if timed.DatabaseTls != nil {
		t.Fatalf("a timed expose reports it: %v", timed)
	}
	on["d1"] = true
	if p, _ := sync(postgres); !p.GetDatabaseTls() {
		t.Fatalf("Postgres once TLS is on: %v", p)
	}
	if p, _ := sync(agentv1.DatabaseEngine_DATABASE_ENGINE_MYSQL); !p.GetDatabaseTls() {
		t.Fatalf("MySQL: %v", p)
	}
	if p, _ := sync(agentv1.DatabaseEngine_DATABASE_ENGINE_MONGO); p.DatabaseTls != nil || !p.GetTls() {
		t.Fatalf("Mongo, whose TLS is the gate's: %v", p)
	}
	if p, _ := sync(agentv1.DatabaseEngine_DATABASE_ENGINE_MARIADB); p.DatabaseTls != nil {
		t.Fatalf("MariaDB, which serves its own: %v", p)
	}
}
