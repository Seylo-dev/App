package agent

import (
	"context"
	"log/slog"
	"slices"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
	"github.com/seylo-dev/app/go/internal/state"
)

// newTestDeps returns Deps with the core block filled by in-memory fakes.
// Owners' wire_<area>_test.go files may use it and set the fields they
// need (a fake docker.Engine, ...).
func newTestDeps(t *testing.T) (*Deps, *rpctest.Recorder) {
	t.Helper()
	rec := rpctest.NewRecorder()
	link := rpc.NewLink()
	return &Deps{
		Layout:     datadir.New(t.TempDir()),
		Logger:     slog.New(slog.DiscardHandler),
		Config:     Config{NodeID: "node1", PanelURL: "https://panel.test"},
		Feed:       state.NewDesiredFeed(),
		Reports:    rec,
		Events:     rec,
		Panel:      rpc.NewPanelClient(link),
		PanelPeer:  link,
		Facts:      NewFacts(rec),
		Components: &Components{},
	}, rec
}

func TestWireAdvertisesOnlyCompleteCapabilities(t *testing.T) {
	d, rec := newTestDeps(t)
	reg, err := Wire(d)
	if err != nil {
		t.Fatal(err)
	}
	// Every advertised capability must have all its methods registered;
	// state.sync.v1 is not complete until the runtime registers SyncDesired & co.
	caps := d.Facts.Get().GetCapabilities()
	if !slices.Equal(caps, reg.Capabilities()) {
		t.Fatalf("facts %v, registry %v", caps, reg.Capabilities())
	}
	for _, name := range []string{"GetNodeFacts", "GetStateSnapshot"} {
		if _, ok := reg.Lookup(name); !ok {
			t.Fatalf("%s not registered", name)
		}
	}

	panel := rpctest.NewPeer(t, reg)
	d.Facts.Update(func(f *agentv1.NodeFacts) { f.Hostname = "n1" })
	rec.WaitEmitted(t, func(e *agentv1.Event) bool { return e.GetNodeFacts().GetHostname() == "n1" })
	var resp agentv1.GetNodeFactsResponse
	if err := panel.Call(context.Background(), "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.GetFacts().GetHostname() != "n1" {
		t.Fatalf("facts = %v", resp.GetFacts())
	}
	err = panel.Call(context.Background(), "GetStateSnapshot", &agentv1.GetStateSnapshotRequest{}, &agentv1.GetStateSnapshotResponse{})
	if s := rpc.StatusOf(err); s.GetCode() != agentv1.StatusCode_STATUS_CODE_UNAVAILABLE {
		t.Fatalf("snapshot without a store = %v", s)
	}
}

func TestWireFailsOnBadRegistration(t *testing.T) {
	d, _ := newTestDeps(t)
	saved := owners
	t.Cleanup(func() { owners = saved })
	owners = append(slices.Clone(saved), owner{"broken", func(*Deps) error { return nil }, func(reg *Registry, _ *Deps) error {
		rpc.HandleUnary(reg, "NoSuchMethod", func(context.Context, *agentv1.PruneRequest) (*agentv1.PruneResponse, error) { return nil, nil })
		return nil
	}})
	if _, err := Wire(d); err == nil {
		t.Fatal("Wire accepted a registration for an unknown method")
	}
}
