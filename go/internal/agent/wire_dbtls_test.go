package agent

import (
	"context"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/portgate"
)

// The portgate asks ExposedTLS whether TLS is on inside an exposed
// Postgres: on a fresh agent it is not yet (the first pass turns it on), so
// the port reports database_tls false rather than leaving it unset.
func TestWireReportsTheDatabaseTLS(t *testing.T) {
	d, _ := newTestDeps(t)
	if _, err := Wire(d); err != nil {
		t.Fatal(err)
	}
	spec := &agentv1.ServiceSpec{Id: "db1", Kind: agentv1.ServiceKind_SERVICE_KIND_DATABASE,
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES,
			Exposure: &agentv1.DatabaseExposure{Enabled: true, AllowedSourceCidrs: []string{"127.0.0.1/32"}}}}}
	ls, errs := portgate.ListenersFor(spec)
	if len(errs) != 0 {
		t.Fatal(errs)
	}
	if _, err := d.Gate.Sync(context.Background(), "db1", ls); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Gate.CloseService("db1") })
	ports := d.Gate.Ports("db1")
	if len(ports) != 1 || ports[0].DatabaseTls == nil || ports[0].GetDatabaseTls() {
		t.Fatalf("exposed Postgres on a fresh agent: %v", ports)
	}
}
