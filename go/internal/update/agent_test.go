package update

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

type fakeSystem struct {
	mu        sync.Mutex
	armed     []string
	disarmed  int
	restarted chan struct{}
	rebooted  chan struct{}
}

func newFakeSystem() *fakeSystem {
	return &fakeSystem{restarted: make(chan struct{}, 4), rebooted: make(chan struct{}, 1)}
}

func (f *fakeSystem) RestartAgent(context.Context) error { f.restarted <- struct{}{}; return nil }
func (f *fakeSystem) Reboot(context.Context) error       { f.rebooted <- struct{}{}; return nil }
func (f *fakeSystem) ArmGuard(_ context.Context, binary, dataDir string, delay time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = append(f.armed, binary+" "+dataDir+" "+delay.String())
	return nil
}
func (f *fakeSystem) DisarmGuard(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.disarmed++
	return nil
}

type reports struct {
	mu     sync.Mutex
	events []*agentv1.UpdateResult
}

func (r *reports) add(_ context.Context, ev *agentv1.Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev.GetUpdateResult())
	return nil
}

func (r *reports) all() []*agentv1.UpdateResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*agentv1.UpdateResult(nil), r.events...)
}

// fakeBinary is a shell script standing in for the agent: `version`
// prints the version it was built for.
func fakeBinary(version string) []byte {
	return []byte("#!/bin/sh\necho \"seylo " + version + " (commit test, built now)\"\n")
}

type agentFixture struct {
	t       *testing.T
	dataDir string
	exe     string
	key     testKey
	system  *fakeSystem
	reports *reports
	server  *httptest.Server
	binary  []byte
}

func newAgentFixture(t *testing.T, newVersion string) *agentFixture {
	t.Helper()
	f := &agentFixture{
		t:       t,
		dataDir: t.TempDir(),
		key:     newTestKey(t),
		system:  newFakeSystem(),
		reports: &reports{},
		binary:  fakeBinary(newVersion),
	}
	binDir := t.TempDir()
	f.exe = filepath.Join(binDir, "seylo")
	if err := os.WriteFile(f.exe, fakeBinary("1.1.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(f.binary)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *agentFixture) updater(current string) *AgentUpdater {
	f.t.Helper()
	u, err := NewAgentUpdater(AgentOptions{
		DataDir:        f.dataDir,
		Executable:     f.exe,
		CurrentVersion: current,
		PublicKey:      f.key.publicText(f.t),
		GOOS:           "linux",
		GOARCH:         "amd64",
		System:         f.system,
		Report:         f.reports.add,
		RestartDelay:   time.Millisecond,
	}, &Lock{})
	if err != nil {
		f.t.Fatal(err)
	}
	return u
}

func (f *agentFixture) request(m *Manifest) *agentv1.UpdateAgentRequest {
	data := marshal(f.t, m)
	return &agentv1.UpdateAgentRequest{Manifest: data, ManifestSignature: f.key.sign(data), TargetVersion: m.Version, UpdateId: "u1"}
}

func readString(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAgentUpdateConfirmed(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	old := f.updater("1.1.0")
	if err := old.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.system.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("agent was not restarted")
	}
	if got := readString(t, f.exe); got != string(f.binary) {
		t.Fatalf("installed binary = %q", got)
	}
	backup := filepath.Join(f.dataDir, "update", agentBackup)
	if !strings.Contains(readString(t, backup), "1.1.0") {
		t.Fatal("backup is not the old binary")
	}
	if len(f.system.armed) != 1 || !strings.HasPrefix(f.system.armed[0], backup+" "+f.dataDir) {
		t.Fatalf("guard = %v", f.system.armed)
	}
	if len(f.reports.all()) != 0 {
		t.Fatal("nothing must be reported before the new agent confirms")
	}

	// The old process reconnecting before its restart must not confirm.
	if err := old.Confirm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.reports.all()) != 0 {
		t.Fatal("the old binary confirmed the update")
	}

	// The new agent connects.
	if err := f.updater("1.2.0").Confirm(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := f.reports.all()
	if len(got) != 1 || !got[0].GetSuccess() || got[0].GetFromVersion() != "1.1.0" || got[0].GetToVersion() != "1.2.0" || got[0].GetUpdateId() != "u1" {
		t.Fatalf("reports = %v", got)
	}
	if f.system.disarmed == 0 {
		t.Fatal("guard was not disarmed")
	}
	// The guard firing late does nothing.
	rolled, err := RunGuard(context.Background(), GuardOptions{DataDir: f.dataDir, Run: failRunner(t)})
	if err != nil || rolled {
		t.Fatalf("late guard: rolled=%v err=%v", rolled, err)
	}
}

func failRunner(t *testing.T) func(context.Context, io.Writer, string, ...string) error {
	return func(_ context.Context, _ io.Writer, name string, args ...string) error {
		t.Errorf("unexpected command %s %v", name, args)
		return nil
	}
}

func TestAgentUpdateRolledBackByGuard(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	if err := f.updater("1.1.0").Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatal(err)
	}
	<-f.system.restarted

	// The new agent never connects; the guard fires.
	var commands []string
	rolled, err := RunGuard(context.Background(), GuardOptions{DataDir: f.dataDir, Run: func(_ context.Context, _ io.Writer, name string, args ...string) error {
		commands = append(commands, name+" "+strings.Join(args, " "))
		return nil
	}})
	if err != nil || !rolled {
		t.Fatalf("guard: rolled=%v err=%v", rolled, err)
	}
	if !strings.Contains(readString(t, f.exe), "1.1.0") {
		t.Fatal("old binary was not restored")
	}
	if strings.Join(commands, ";") != "systemctl reset-failed seylo.service;systemctl restart seylo.service" {
		t.Fatalf("commands = %v", commands)
	}

	// A late confirm from the new binary must not win.
	if err := f.updater("1.2.0").Confirm(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.reports.all()) != 0 {
		t.Fatal("confirm after the rollback reported")
	}

	// The restored agent starts and reports the rollback once.
	restored := f.updater("1.1.0")
	if err := restored.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := restored.Resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := f.reports.all()
	if len(got) != 1 || got[0].GetSuccess() || !got[0].GetRolledBack() || got[0].GetTarget() != agentv1.UpdateTarget_UPDATE_TARGET_AGENT || got[0].GetError() == "" {
		t.Fatalf("reports = %v", got)
	}
}

func TestAgentUpdateRefusals(t *testing.T) {
	ctx := context.Background()
	t.Run("hash mismatch", func(t *testing.T) {
		f := newAgentFixture(t, "1.2.0")
		m := testManifest("1.2.0", f.binary, f.server.URL)
		f.binary = fakeBinary("6.6.6") // served file differs from the manifest
		err := f.updater("1.1.0").Update(ctx, f.request(m))
		if err == nil || !strings.Contains(err.Error(), "bytes") && !strings.Contains(err.Error(), "SHA-256") {
			t.Fatalf("err = %v", err)
		}
		if !strings.Contains(readString(t, f.exe), "1.1.0") {
			t.Fatal("binary changed after a failed check")
		}
		got := f.reports.all()
		if len(got) != 1 || got[0].GetSuccess() || got[0].GetToVersion() != "1.2.0" {
			t.Fatalf("reports = %v", got)
		}
		if len(f.system.armed) != 0 {
			t.Fatal("guard armed for a failed download")
		}
	})
	t.Run("binary reports another version", func(t *testing.T) {
		f := newAgentFixture(t, "1.3.0")
		err := f.updater("1.1.0").Update(ctx, f.request(testManifest("1.2.0", f.binary, f.server.URL)))
		if err == nil || !strings.Contains(err.Error(), "want version 1.2.0") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("up to date", func(t *testing.T) {
		f := newAgentFixture(t, "1.2.0")
		err := f.updater("1.2.0").Update(ctx, f.request(testManifest("1.2.0", f.binary, f.server.URL)))
		if !errors.Is(err, ErrUpToDate) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("target differs from manifest", func(t *testing.T) {
		f := newAgentFixture(t, "1.2.0")
		req := f.request(testManifest("1.2.0", f.binary, f.server.URL))
		req.TargetVersion = "1.3.0"
		if err := f.updater("1.1.0").Update(ctx, req); !errors.Is(err, ErrRejected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("bad signature", func(t *testing.T) {
		f := newAgentFixture(t, "1.2.0")
		req := f.request(testManifest("1.2.0", f.binary, f.server.URL))
		req.ManifestSignature = newTestKey(t).sign(req.Manifest)
		if err := f.updater("1.1.0").Update(ctx, req); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("busy", func(t *testing.T) {
		f := newAgentFixture(t, "1.2.0")
		lock := &Lock{}
		release, _ := lock.TryAcquire("panel update")
		defer release()
		u, _ := NewAgentUpdater(AgentOptions{DataDir: f.dataDir, Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: f.key.publicText(t), System: f.system}, lock)
		if err := u.Update(ctx, f.request(testManifest("1.2.0", f.binary, f.server.URL))); !errors.Is(err, ErrBusy) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestCheckOnConnect(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	u := f.updater("1.1.0")
	// Auto-update off, or the panel not newer: nothing is fetched.
	for _, c := range []struct {
		panel string
		on    bool
	}{{"1.2.0", false}, {"1.1.0", true}, {"dev", true}} {
		if err := u.CheckOnConnect(context.Background(), c.panel, c.on); err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
	}
	if len(f.system.armed) != 0 {
		t.Fatal("updated although it should not")
	}
	// Turned on with a newer panel it fetches the release from GitHub,
	// which tests cannot reach: the error names the target and the next
	// connect within the hour does not retry.
	u.opts.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("offline: " + r.URL.String())
	})}
	err := u.CheckOnConnect(context.Background(), "v1.2.0", true)
	if err == nil || !strings.Contains(err.Error(), "releases/download/v1.2.0/manifest.json") {
		t.Fatalf("err = %v", err)
	}
	if err := u.CheckOnConnect(context.Background(), "1.2.0", true); err != nil {
		t.Fatalf("retried within the hour: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRebootRefusesWhileBusy(t *testing.T) {
	sys := newFakeSystem()
	lock := &Lock{}
	s := &Service{System: sys, Lock: lock}
	release, _ := lock.TryAcquire("panel update")
	if err := s.Reboot(context.Background(), time.Millisecond); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
	release()
	if err := s.Reboot(context.Background(), time.Millisecond); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sys.rebooted:
	case <-time.After(5 * time.Second):
		t.Fatal("did not reboot")
	}
	if s.Busy() != "reboot" {
		t.Fatalf("Busy = %q", s.Busy())
	}
}
