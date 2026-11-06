package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// isolate replaces the owners' wire files with a test owner that registers
// the rest of state.sync.v1 on DesiredSync, so these tests do not depend
// on Docker or on other owners' work, and shortens the reconnect timing.
func isolate(t *testing.T) {
	t.Helper()
	saved := owners
	savedTiming := []time.Duration{reconnectMin, reconnectMax, rejectedRetry, drainRetryMax}
	t.Cleanup(func() {
		owners = saved
		reconnectMin, reconnectMax, rejectedRetry, drainRetryMax = savedTiming[0], savedTiming[1], savedTiming[2], savedTiming[3]
	})
	reconnectMin, reconnectMax, rejectedRetry, drainRetryMax = 20*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond, 100*time.Millisecond
	owners = []owner{{"test-sync", func(*Deps) error { return nil }, func(reg *Registry, d *Deps) error {
		rpc.HandleUnary(reg, "SyncDesired", func(ctx context.Context, req *agentv1.SyncDesiredRequest) (*agentv1.SyncDesiredResponse, error) {
			rev, _, err := d.DesiredSync.Sync(ctx, req.GetState())
			return &agentv1.SyncDesiredResponse{AcceptedRevision: rev}, err
		})
		rpc.HandleUnary(reg, "ApplyService", func(ctx context.Context, req *agentv1.ApplyServiceRequest) (*agentv1.ApplyServiceResponse, error) {
			rev, _, err := d.DesiredSync.Apply(ctx, req.GetRevision(), req.GetService())
			return &agentv1.ApplyServiceResponse{AcceptedRevision: rev}, err
		})
		rpc.HandleUnary(reg, "RemoveService", func(ctx context.Context, req *agentv1.RemoveServiceRequest) (*agentv1.RemoveServiceResponse, error) {
			rev, _, err := d.DesiredSync.Remove(ctx, req.GetRevision(), req.GetServiceId())
			return &agentv1.RemoveServiceResponse{AcceptedRevision: rev}, err
		})
		rpc.HandleUnary(reg, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
			return &agentv1.RestartServiceResponse{}, nil
		})
		return nil
	}}}
}

// shortLayout is a data dir under /tmp: unix socket paths must stay under
// about 100 bytes, which t.TempDir on macOS exceeds.
func shortLayout(t *testing.T) datadir.Layout {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "ag-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return datadir.New(dir)
}

type running struct {
	d      *daemon
	cancel context.CancelFunc
	done   chan struct{} // closed when run returned, with err set
	err    error
}

func (r *running) stop(t *testing.T) {
	t.Helper()
	r.cancel()
	select {
	case <-r.done:
		if r.err != nil {
			t.Fatalf("run returned %v", r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("agent did not stop")
	}
}

func startDaemon(t *testing.T, layout datadir.Layout) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	d, err := newDaemon(ctx, layout, slog.New(slog.DiscardHandler))
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	r := &running{d: d, cancel: cancel, done: make(chan struct{})}
	go func() {
		r.err = d.run(ctx)
		close(r.done)
	}()
	t.Cleanup(func() {
		cancel()
		<-r.done
	})
	return r
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestJoinResumeAndCallsBothWays(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok1")
	panel.SetDesired(&agentv1.DesiredState{Revision: 9, Services: []*agentv1.ServiceSpec{{Id: "web", Name: "web", ProjectId: "p1"}}})
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok1", Name: "edge-1"}); err != nil {
		t.Fatal(err)
	}
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok1", Name: "edge-1"}); err != nil {
		t.Fatalf("re-running join before it completed: %v", err)
	}
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	ctx := context.Background()

	// The join was recorded and the token dropped.
	waitUntil(t, "the node id in config.yml", func() bool {
		cfg, err := LoadConfig(layout.ConfigFile())
		return err == nil && cfg.NodeID == nodeID && cfg.JoinToken == ""
	})
	info, _ := os.Stat(layout.AgentKey())
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("agent key mode %v", info.Mode())
	}
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok2"}); !errors.Is(err, ErrAlreadyJoined) {
		t.Fatalf("joining a joined node = %v", err)
	}
	hello := panel.Hellos()[0]
	if hello.GetJoin().GetRequestedName() != "edge-1" || hello.GetFacts().GetHostname() == "" || hello.GetAgentVersion() == "" {
		t.Fatalf("join hello = %v", hello)
	}
	if caps := hello.GetFacts().GetCapabilities(); len(caps) != 1 || caps[0] != "state.sync.v1" {
		t.Fatalf("capabilities = %v", caps)
	}

	// Empty desired state: the agent fetched it from the panel.
	waitUntil(t, "desired state from GetDesiredState", func() bool { return a.d.deps.DesiredSync.Revision() == 9 })

	// Panel -> agent.
	session := panel.Session(nodeID)
	var facts agentv1.GetNodeFactsResponse
	if err := session.Call(ctx, "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &facts); err != nil {
		t.Fatal(err)
	}
	if facts.GetFacts().GetCpuCores() == 0 || facts.GetFacts().GetMemoryTotalBytes() == 0 || facts.GetFacts().GetDiskTotalBytes() == 0 {
		t.Fatalf("machine facts missing: %v", facts.GetFacts())
	}
	var synced agentv1.SyncDesiredResponse
	err := session.Call(ctx, "SyncDesired", &agentv1.SyncDesiredRequest{State: &agentv1.DesiredState{Revision: 12, Services: []*agentv1.ServiceSpec{{Id: "api", Name: "api"}}}}, &synced)
	if err != nil || synced.GetAcceptedRevision() != 12 {
		t.Fatalf("sync = %v, %v", &synced, err)
	}

	// Agent -> panel: durable report and best-effort state delta.
	if err := a.d.deps.Reports.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: "r1"}}}); err != nil {
		t.Fatal(err)
	}
	if r := panel.WaitReports(1); r[0].OutboxID == 0 || r[0].Event.GetCronRun().GetRunId() != "r1" || r[0].NodeID != nodeID {
		t.Fatalf("report = %+v", r[0])
	}
	a.d.deps.State.SetService(&agentv1.ServiceStatus{ServiceId: "api", Phase: agentv1.ServicePhase_SERVICE_PHASE_RUNNING})
	panel.WaitEvent(func(e *agentv1.Event) bool { return e.GetStateDelta().GetServiceUpdated().GetServiceId() == "api" })

	// The local API reports the connection.
	status, err := localapi.NewClient(layout).Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !status.PanelConnected || status.NodeID != nodeID || status.DesiredRevision != 12 || len(status.Services) != 1 || status.Services[0].Phase != "running" {
		t.Fatalf("status = %+v", status)
	}

	// A dropped connection comes back with a resume. DropConnections returns
	// once the old session is gone, so the live one is the reconnect.
	panel.DropConnections()
	panel.WaitConnected(nodeID)
	hellos := panel.Hellos()
	if last := hellos[len(hellos)-1]; last.GetResume().GetNodeId() != nodeID {
		t.Fatalf("reconnect hello = %v", last)
	}
	if err := panel.Session(nodeID).Call(ctx, "GetNodeFacts", &agentv1.GetNodeFactsRequest{}, &facts); err != nil {
		t.Fatalf("call after reconnect: %v", err)
	}

	// The desired state survives an agent restart, before any connection.
	a.stop(t)
	if _, err := os.Stat(layout.AgentSocket()); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
	d2, err := newDaemon(ctx, layout, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	if cur := d2.deps.Feed.Current(); cur.GetRevision() != 12 || cur.GetServices()[0].GetId() != "api" {
		t.Fatalf("feed after restart = %v", cur)
	}
}

func TestOutboxReplayAfterRestart(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("tok")
	panel.FailReports(rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "database busy"))
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tok"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	panel.WaitConnected("")
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		if err := a.d.deps.Reports.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_CronRun{CronRun: &agentv1.CronRun{RunId: id}}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.d.deps.Reports.Crash(ctx, &agentv1.CrashReport{ServiceId: "web", ExitCode: 137, OomKilled: true}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "a failed delivery", func() bool {
		s, _ := a.d.backend.Status(ctx)
		return len(s.RecentErrors) > 0
	})
	a.stop(t)
	if len(panel.Reports()) != 0 {
		t.Fatal("reports delivered while the panel refused them")
	}

	panel.FailReports(nil)
	b := startDaemon(t, layout)
	reports := panel.WaitReports(4)
	first := reports[0].OutboxID
	for i, want := range []string{"a", "b", "c"} {
		if reports[i].OutboxID != first+uint64(i) || reports[i].Event.GetCronRun().GetRunId() != want {
			t.Fatalf("report %d = %+v", i, reports[i])
		}
	}
	if reports[3].OutboxID != first+3 || !reports[3].Crash.GetOomKilled() {
		t.Fatalf("crash report = %+v", reports[3])
	}
	waitUntil(t, "an empty outbox", func() bool {
		s, _ := b.d.backend.Status(ctx)
		return s.Outbox.Pending == 0
	})
	// New reports continue the numbering (above every id handed out before
	// the restart, at least the start time in microseconds).
	_ = b.d.deps.Reports.Event(ctx, &agentv1.Event{})
	if r := panel.WaitReports(5); r[4].OutboxID <= first+3 {
		t.Fatalf("next id = %d", r[4].OutboxID)
	}
}

func TestHandshakeRejections(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("once")
	first := shortLayout(t)
	_ = Join(first, JoinOptions{PanelURL: panel.URL(), Token: "once"})
	a := startDaemon(t, first)
	nodeID := panel.WaitConnected("")

	// The token is single use.
	second := shortLayout(t)
	_ = Join(second, JoinOptions{PanelURL: panel.URL(), Token: "once"})
	b := startDaemon(t, second)
	if r := panel.WaitRejected(1); r.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_INVALID_TOKEN {
		t.Fatalf("reused token = %v", r)
	}
	waitUntil(t, "the rejected state", func() bool {
		s, _ := b.d.backend.Status(context.Background())
		return s.Connection.State == "rejected" && strings.Contains(s.Connection.LastError, "INVALID_TOKEN")
	})
	b.stop(t)

	// A different key cannot resume the node.
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	if err := os.WriteFile(first.AgentKey(), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	startDaemon(t, first)
	if r := panel.WaitRejected(2); r.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_BAD_SIGNATURE {
		t.Fatalf("wrong key = %v", r)
	}
}

func TestTrustOnFirstUseThenPin(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t, rpctest.WithTLS())
	panel.AddJoinToken("tofu")
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: panel.URL(), Token: "tofu", TrustOnFirstUse: true}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	waitUntil(t, "the pin in config.yml", func() bool {
		cfg, _ := LoadConfig(layout.ConfigFile())
		return cfg != nil && cfg.PanelPin == conn.FormatPin(panel.SPKI()) && !cfg.TrustOnFirstUse
	})
	a.stop(t)
	panel.WaitDisconnected(nodeID)
	startDaemon(t, layout)
	panel.WaitConnected(nodeID) // now through the pin

	// A wrong pin never connects.
	panel.AddJoinToken("pinned")
	wrong := shortLayout(t)
	if err := Join(wrong, JoinOptions{PanelURL: panel.URL(), Token: "pinned", Pin: conn.FormatPin(make([]byte, 32))}); err != nil {
		t.Fatal(err)
	}
	b := startDaemon(t, wrong)
	waitUntil(t, "a pin mismatch", func() bool {
		s, _ := b.d.backend.Status(context.Background())
		return strings.Contains(s.Connection.LastError, "pinned key")
	})
	if len(panel.Hellos()) != 2 {
		t.Fatalf("hellos = %d: the mismatched agent got through", len(panel.Hellos()))
	}
}

func TestRunJoinsAndStops(t *testing.T) {
	isolate(t)
	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("t")
	layout := shortLayout(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Options{Layout: layout, Join: &JoinOptions{PanelURL: panel.URL(), Token: "t"}})
	}()
	panel.WaitConnected("")
	waitUntil(t, "the local socket", func() bool { return localapi.Available(layout.AgentSocket()) })
	v, err := localapi.NewClient(layout).Version(ctx)
	if err != nil || v.Version == "" {
		t.Fatalf("version = %v, %v", v, err)
	}
	if _, err := localapi.NewClient(layout).PanelStatus(ctx); err != nil {
		t.Fatal(err)
	}
	if err := localapi.NewClient(layout).StartPanel(ctx); err == nil || !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("start panel without PanelControl = %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

func TestAgentURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://panel.example.com":     "wss://panel.example.com/api/agent/connect",
		"http://10.0.0.1:3000/":         "ws://10.0.0.1:3000/api/agent/connect",
		"https://example.com/seylo?x=1": "wss://example.com/seylo/api/agent/connect",
	} {
		if got, err := AgentURL(in); err != nil || got != want {
			t.Errorf("AgentURL(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "panel.example.com", "ftp://x"} {
		if _, err := AgentURL(bad); err == nil {
			t.Errorf("AgentURL(%q) accepted", bad)
		}
	}
}

func TestBackoffBounds(t *testing.T) {
	for attempt := 1; attempt < 40; attempt++ {
		d := backoff(attempt)
		if d < reconnectMin/2 || d > reconnectMax {
			t.Fatalf("backoff(%d) = %s", attempt, d)
		}
	}
}

func TestPlainHTTPJoinNeedsInsecure(t *testing.T) {
	for in, want := range map[string]bool{
		"http://203.0.113.7:3000":    true,
		"http://10.0.0.1:3000":       true,
		"ws://panel.example.com":     true,
		"http://127.0.0.1:3000":      false,
		"http://[::1]:3000":          false,
		"http://localhost:3000":      false,
		"https://203.0.113.7:3443":   false,
		"https://panel.example.com/": false,
	} {
		if got := PlainRemote(in); got != want {
			t.Errorf("PlainRemote(%q) = %v", in, got)
		}
	}
	layout := shortLayout(t)
	err := Join(layout, JoinOptions{PanelURL: "http://203.0.113.7:3000", Token: "t"})
	if !errors.Is(err, ErrPlainTransport) || !strings.Contains(err.Error(), "--pin") || !strings.Contains(err.Error(), "--insecure") {
		t.Fatalf("plain HTTP join = %v", err)
	}
	if _, statErr := os.Stat(layout.ConfigFile()); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("a refused join wrote config.yml: %v", statErr)
	}
	if err := Join(layout, JoinOptions{PanelURL: "http://203.0.113.7:3000", Token: "t", Insecure: true}); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(layout.ConfigFile())
	if err != nil || !cfg.InsecureTransport {
		t.Fatalf("config = %+v, %v", cfg, err)
	}
	// A pinned https URL needs nothing, and drops the flag.
	if err := Join(layout, JoinOptions{PanelURL: "https://203.0.113.7:3443", Token: "t", Pin: "sha256:" + strings.Repeat("ab", 32), Insecure: true, Force: true}); err != nil {
		t.Fatal(err)
	}
	if cfg, err := LoadConfig(layout.ConfigFile()); err != nil || cfg.InsecureTransport || cfg.PanelPin == "" {
		t.Fatalf("config = %+v, %v", cfg, err)
	}
	// A node that joined over plain HTTP before the rule keeps loading.
	if err := SaveConfig(layout.ConfigFile(), &FileConfig{PanelURL: "http://203.0.113.7:3000", NodeID: "n1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(layout.ConfigFile()); err != nil {
		t.Fatalf("joined plain-HTTP node: %v", err)
	}
}
