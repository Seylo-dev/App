package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakePanel is a panel service whose "database" is panel.db on disk: the
// new image writes to it on start, like a migration would.
type fakePanel struct {
	mu        sync.Mutex
	dir       string
	running   string
	healthy   map[string]bool
	steps     []string
	pullError error
	// stopErrorAfter fails every Stop after that many successful ones.
	stopErrorAfter int
	stops          int
	// blockHealth makes WaitHealthy wait for its context to end.
	blockHealth bool
	// healthGate, when set, holds WaitHealthy until it is closed.
	healthGate chan struct{}
}

func (p *fakePanel) log(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.steps = append(p.steps, s)
}

func (p *fakePanel) CurrentImage(context.Context, string) (*agentv1.ImageRef, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return &agentv1.ImageRef{Reference: p.running, Digest: "sha256:" + strings.TrimPrefix(p.running, "panel:")}, nil
}

func (p *fakePanel) Pull(_ context.Context, img *agentv1.ImageRef) error {
	p.log("pull " + img.GetReference())
	return p.pullError
}

func (p *fakePanel) Stop(context.Context, string) error {
	p.log("stop")
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopErrorAfter > 0 && p.stops >= p.stopErrorAfter {
		return errors.New("docker did not answer")
	}
	p.stops++
	p.running = ""
	return nil
}

func (p *fakePanel) Start(_ context.Context, _ string, img *agentv1.ImageRef) error {
	p.log("start " + img.GetReference())
	p.mu.Lock()
	p.running = img.GetReference()
	p.mu.Unlock()
	// The new panel migrates its database and leaves a WAL behind.
	if img.GetReference() == "panel:new" {
		_ = os.WriteFile(filepath.Join(p.dir, "panel.db"), []byte("migrated"), 0o600)
		_ = os.WriteFile(filepath.Join(p.dir, "panel.db-wal"), []byte("wal"), 0o600)
	}
	return nil
}

func (p *fakePanel) WaitHealthy(ctx context.Context, _ string, _ time.Duration) error {
	p.mu.Lock()
	block, gate := p.blockHealth, p.healthGate
	p.mu.Unlock()
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.healthy[p.running] {
		return nil
	}
	return errors.New("health check failed")
}

func (p *fakePanel) Steps() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.Join(p.steps, "; ")
}

func panelFixture(t *testing.T, healthy map[string]bool) (*PanelSwapper, *fakePanel, *reports, string) {
	t.Helper()
	return panelFixtureLocked(t, healthy, &Lock{})
}

// panelFixtureLocked is panelFixture with the node's update lock shared
// with other updaters.
func panelFixtureLocked(t *testing.T, healthy map[string]bool, lock *Lock) (*PanelSwapper, *fakePanel, *reports, string) {
	t.Helper()
	dataDir := t.TempDir()
	panelDir := filepath.Join(dataDir, "panel")
	if err := os.MkdirAll(panelDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"panel.db": "original", "metrics.db": "metrics"} {
		if err := os.WriteFile(filepath.Join(panelDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rt := &fakePanel{dir: panelDir, running: "panel:old", healthy: healthy}
	rep := &reports{}
	s := NewPanelSwapper(PanelOptions{
		DataDir:      dataDir,
		Runtime:      rt,
		Report:       rep.add,
		PanelVersion: func() string { return "1.1.0" },
	}, lock)
	return s, rt, rep, dataDir
}

func swapRequest() *agentv1.UpdatePanelRequest {
	return &agentv1.UpdatePanelRequest{
		UpdateId:      "p1",
		ServiceId:     "panel",
		Image:         &agentv1.ImageRef{Reference: "panel:new", Digest: "sha256:new"},
		TargetVersion: "1.2.0",
	}
}

func waitReport(t *testing.T, rep *reports) *agentv1.UpdateResult {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := rep.all(); len(got) > 0 {
			return got[0]
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no update result")
	return nil
}

func TestPanelSwapSucceeds(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:new": true})
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetSuccess() || r.GetRolledBack() || r.GetFromVersion() != "1.1.0" || r.GetToVersion() != "1.2.0" || r.GetTarget() != agentv1.UpdateTarget_UPDATE_TARGET_PANEL {
		t.Fatalf("result = %v", r)
	}
	if got := rt.Steps(); got != "pull panel:new; stop; start panel:new" {
		t.Fatalf("steps = %s", got)
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "migrated" {
		t.Fatalf("panel.db = %q", got)
	}
	if exists(filepath.Join(dataDir, "update", panelJournal)) {
		t.Fatal("journal left behind")
	}
	snaps, _ := os.ReadDir(filepath.Join(dataDir, "update", panelSnaps))
	if len(snaps) != 1 {
		t.Fatalf("snapshots = %d", len(snaps))
	}
}

func TestPanelSwapRollsBack(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:old": true})
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if r.GetSuccess() || !r.GetRolledBack() || !strings.Contains(r.GetError(), "did not become healthy") {
		t.Fatalf("result = %v", r)
	}
	if got := rt.Steps(); got != "pull panel:new; stop; start panel:new; stop; start panel:old" {
		t.Fatalf("steps = %s", got)
	}
	panelDir := filepath.Join(dataDir, "panel")
	if got := readString(t, filepath.Join(panelDir, "panel.db")); got != "original" {
		t.Fatalf("panel.db = %q, want the snapshot", got)
	}
	if exists(filepath.Join(panelDir, "panel.db-wal")) {
		t.Fatal("the new panel's WAL survived the restore")
	}
	if got := readString(t, filepath.Join(panelDir, "metrics.db")); got != "metrics" {
		t.Fatalf("metrics.db = %q", got)
	}
}

func TestPanelSwapPullFailureLeavesPanelRunning(t *testing.T) {
	s, rt, rep, _ := panelFixture(t, nil)
	rt.pullError = errors.New("manifest unknown")
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if r.GetSuccess() || r.GetRolledBack() || !strings.Contains(r.GetError(), "manifest unknown") {
		t.Fatalf("result = %v", r)
	}
	if rt.Steps() != "pull panel:new" {
		t.Fatalf("steps = %s", rt.Steps())
	}
}

func TestPanelSwapValidates(t *testing.T) {
	s, _, _, _ := panelFixture(t, nil)
	req := swapRequest()
	req.Image.Digest = ""
	if err := s.Swap(context.Background(), req); !errors.Is(err, ErrRejected) {
		t.Fatalf("err = %v", err)
	}
}

func TestPanelSwapResumeAfterAgentRestart(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:old": true})
	// Simulate a crash after the snapshot while the new panel was starting.
	j := &panelSwap{UpdateID: "p1", ServiceID: "panel", FromVersion: "1.1.0", ToVersion: "1.2.0", HealthTimeout: "1s", StartedAt: time.Now()}
	j.OldImage, j.NewImage = mustMarshal(&agentv1.ImageRef{Reference: "panel:old"}), mustMarshal(&agentv1.ImageRef{Reference: "panel:new"})
	if err := s.snapshot(j); err != nil {
		t.Fatal(err)
	}
	j.Phase = phaseStarting
	if err := writeJSON(s.journal(), j); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dataDir, "panel", "panel.db"), []byte("half migrated"), 0o600)

	if err := s.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetRolledBack() || !strings.Contains(r.GetError(), "restarted during the panel update") {
		t.Fatalf("result = %v", r)
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "original" {
		t.Fatalf("panel.db = %q", got)
	}
	if !strings.HasSuffix(rt.Steps(), "start panel:old") {
		t.Fatalf("steps = %s", rt.Steps())
	}
}

// failingReports refuses the first fail reports (an outbox on a full disk,
// or an agent that is stopping), then queues like reports.
type failingReports struct {
	reports
	fail int
}

func (r *failingReports) add(ctx context.Context, ev *agentv1.Event) error {
	r.mu.Lock()
	if r.fail > 0 {
		r.fail--
		r.mu.Unlock()
		return errors.New("no space left on device")
	}
	r.mu.Unlock()
	return r.reports.add(ctx, ev)
}

func readJournal(t *testing.T, s *PanelSwapper) panelSwap {
	t.Helper()
	var j panelSwap
	if err := readJSON(s.journal(), &j); err != nil {
		t.Fatal(err)
	}
	return j
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A swap that succeeded but could not queue its result must never be
// rolled back on the next start: the new panel is the live one by then.
func TestPanelSwapResultNotQueuedIsNotRolledBack(t *testing.T) {
	s, rt, _, dataDir := panelFixture(t, map[string]bool{"panel:new": true, "panel:old": true})
	rep := &failingReports{fail: 1}
	s.opts.Report = rep.add
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the done journal", func() bool {
		var j panelSwap
		return readJSON(s.journal(), &j) == nil && j.Phase == phaseDone
	})
	waitFor(t, "the swap to release the lock", func() bool { return s.lock.Holder() == "" })
	if len(rep.all()) != 0 {
		t.Fatal("the failed report was counted")
	}
	// The new panel keeps working for a while.
	panelDB := filepath.Join(dataDir, "panel", "panel.db")
	_ = os.WriteFile(panelDB, []byte("written after the update"), 0o600)

	stepsBefore := rt.Steps()
	if err := s.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := rep.all()
	if len(got) != 1 || !got[0].GetSuccess() || got[0].GetRolledBack() || got[0].GetToVersion() != "1.2.0" {
		t.Fatalf("results = %v", got)
	}
	if rt.Steps() != stepsBefore {
		t.Fatalf("Resume touched the panel: %s", rt.Steps())
	}
	if got := readString(t, panelDB); got != "written after the update" {
		t.Fatalf("panel.db = %q, the snapshot was restored", got)
	}
	if exists(s.journal()) {
		t.Fatal("journal left behind")
	}
}

// A crash between the health check and the report leaves phaseHealthy:
// the next start reports success and leaves the panel alone.
func TestPanelSwapResumeHealthyReportsSuccess(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:new": true})
	j := &panelSwap{UpdateID: "p1", ServiceID: "panel", FromVersion: "1.1.0", ToVersion: "1.2.0", HealthTimeout: "1s", StartedAt: time.Now()}
	j.OldImage, j.NewImage = mustMarshal(&agentv1.ImageRef{Reference: "panel:old"}), mustMarshal(&agentv1.ImageRef{Reference: "panel:new"})
	if err := s.snapshot(j); err != nil {
		t.Fatal(err)
	}
	j.Phase = phaseHealthy
	if err := writeJSON(s.journal(), j); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dataDir, "panel", "panel.db"), []byte("live"), 0o600)
	if err := s.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetSuccess() || r.GetRolledBack() {
		t.Fatalf("result = %v", r)
	}
	if rt.Steps() != "" {
		t.Fatalf("steps = %s", rt.Steps())
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "live" {
		t.Fatalf("panel.db = %q", got)
	}
}

// The agent restarted while waiting for the health check and the new
// panel came up on its own: success, no rollback.
func TestPanelSwapResumeStartingWithLiveNewPanel(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:new": true})
	j := &panelSwap{UpdateID: "p1", ServiceID: "panel", FromVersion: "1.1.0", ToVersion: "1.2.0", HealthTimeout: "1s", StartedAt: time.Now()}
	j.OldImage = mustMarshal(&agentv1.ImageRef{Reference: "panel:old", Digest: "sha256:old"})
	j.NewImage = mustMarshal(&agentv1.ImageRef{Reference: "panel:new", Digest: "sha256:new"})
	if err := s.snapshot(j); err != nil {
		t.Fatal(err)
	}
	j.Phase = phaseStarting
	if err := writeJSON(s.journal(), j); err != nil {
		t.Fatal(err)
	}
	rt.running = "panel:new"
	_ = os.WriteFile(filepath.Join(dataDir, "panel", "panel.db"), []byte("live"), 0o600)
	if err := s.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetSuccess() || r.GetRolledBack() {
		t.Fatalf("result = %v", r)
	}
	if rt.Steps() != "" {
		t.Fatalf("steps = %s", rt.Steps())
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "live" {
		t.Fatalf("panel.db = %q", got)
	}
}

// The agent stopping mid health check must not run a rollback with a dead
// context (Stop fails at once, the snapshot would be copied over a running
// panel's database): the journal stays for the next start.
func TestPanelSwapAgentStopLeavesJournalForResume(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:new": true})
	rt.blockHealth = true
	ctx, cancel := context.WithCancel(context.Background())
	s.SetBackground(ctx)
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the new panel to start", func() bool { return strings.HasSuffix(rt.Steps(), "start panel:new") })
	cancel()
	waitFor(t, "the swap to stop", func() bool { return s.lock.Holder() == "" })
	if got := rt.Steps(); got != "pull panel:new; stop; start panel:new" {
		t.Fatalf("steps = %s", got)
	}
	if len(rep.all()) != 0 {
		t.Fatalf("reported %v", rep.all())
	}
	if j := readJournal(t, s); j.Phase != phaseStarting {
		t.Fatalf("journal phase = %s", j.Phase)
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "migrated" {
		t.Fatalf("panel.db = %q", got)
	}

	rt.mu.Lock()
	rt.blockHealth = false
	rt.mu.Unlock()
	if err := s.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetSuccess() || r.GetRolledBack() {
		t.Fatalf("result = %v", r)
	}
	if got := rt.Steps(); got != "pull panel:new; stop; start panel:new" {
		t.Fatalf("Resume touched the live panel: %s", got)
	}
}

// A rollback whose Stop fails leaves the database alone.
func TestPanelSwapRollbackKeepsDatabaseWhenStopFails(t *testing.T) {
	s, rt, rep, dataDir := panelFixture(t, map[string]bool{"panel:old": true})
	rt.stopErrorAfter = 1
	if err := s.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if r.GetSuccess() || r.GetRolledBack() || !strings.Contains(r.GetError(), "the database was not restored") {
		t.Fatalf("result = %v", r)
	}
	if got := rt.Steps(); got != "pull panel:new; stop; start panel:new; stop" {
		t.Fatalf("steps = %s", got)
	}
	if got := readString(t, filepath.Join(dataDir, "panel", "panel.db")); got != "migrated" {
		t.Fatalf("panel.db = %q, restored under a running panel", got)
	}
}
