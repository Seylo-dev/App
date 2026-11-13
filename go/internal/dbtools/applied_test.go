package dbtools

import (
	"context"
	"errors"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Applied says whether TLS is on inside an exposed database in this run:
// not while the job fails (the database is still starting), yes once it
// ran, and OnApplied fires once then, so the agent republishes the port's
// database_tls. A later pass with the same certificate runs nothing, and
// Apply again does not fire it twice.
func TestExposedTLSAppliedAndOnApplied(t *testing.T) {
	x := NewExposedTLS(nil, nil, t.TempDir(), t.TempDir(), nil)
	ran := 0
	fail := true
	x.runJob = func(_ context.Context, spec *agentv1.ServiceSpec, job exposedJob) error {
		ran++
		if spec.GetId() != "db1" || len(job.argv) != 3 || job.argv[0] != "sh" {
			t.Errorf("job %v for %s", job.argv, spec.GetId())
		}
		if fail {
			return errors.New("the database is not running")
		}
		return nil
	}
	fired := make(chan string, 4)
	x.OnApplied = func(id string) { fired <- id }
	spec := dbSpec("db1", agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES, false)
	spec.GetDatabase().Exposure = &agentv1.DatabaseExposure{Enabled: true}
	x.Sync([]*agentv1.ServiceSpec{spec})
	ctx := context.Background()

	x.applyAll(ctx)
	if ran != 1 || x.Applied("db1") {
		t.Fatalf("after a failed pass: ran %d, applied %v", ran, x.Applied("db1"))
	}
	fail = false
	x.applyAll(ctx)
	if ran != 2 || !x.Applied("db1") {
		t.Fatalf("after a pass that ran: ran %d, applied %v", ran, x.Applied("db1"))
	}
	select {
	case id := <-fired:
		if id != "db1" {
			t.Fatalf("OnApplied(%q)", id)
		}
	case <-time.After(time.Second):
		t.Fatal("OnApplied not called")
	}
	x.applyAll(ctx)
	if ran != 2 {
		t.Fatalf("the same certificate installed again: ran %d", ran)
	}
	if err := x.Apply(ctx, spec); err != nil || ran != 3 {
		t.Fatalf("Apply: %v, ran %d", err, ran)
	}
	select {
	case id := <-fired:
		t.Fatalf("OnApplied(%q) twice", id)
	case <-time.After(50 * time.Millisecond):
	}
	if x.Applied("db2") {
		t.Fatal("another database counted as applied")
	}
}
