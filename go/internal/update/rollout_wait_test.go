package update

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func (f *agentFixture) updaterWaiting(current string, unverified *atomic.Int64, wait time.Duration) *AgentUpdater {
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
		Unverified:     func() int { return int(unverified.Load()) },
		RolloutWait:    wait,
	}, &Lock{})
	if err != nil {
		f.t.Fatal(err)
	}
	return u
}

func fastRolloutPoll(t *testing.T) {
	t.Helper()
	was := rolloutPoll
	rolloutPoll = 5 * time.Millisecond
	t.Cleanup(func() { rolloutPoll = was })
}

// An update while a deploy is in its health check does not restart the
// agent under it (the restart would roll it back, and a panel deploy
// would flip the panel twice): the request returns, and the swap and
// restart follow once the deploy is verified.
func TestAgentUpdateWaitsForUnverifiedDeploys(t *testing.T) {
	fastRolloutPoll(t)
	f := newAgentFixture(t, "1.2.0")
	var unverified atomic.Int64
	unverified.Store(1)
	u := f.updaterWaiting("1.1.0", &unverified, time.Minute)
	if err := u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.system.restarted:
		t.Fatal("the agent restarted while a deploy was unverified")
	case <-time.After(200 * time.Millisecond):
	}
	if !strings.Contains(readString(t, f.exe), "1.1.0") {
		t.Fatal("the binary was swapped while a deploy was unverified")
	}
	f.system.mu.Lock()
	armed := len(f.system.armed)
	f.system.mu.Unlock()
	if armed != 0 {
		t.Fatal("the guard was armed before the wait ended: it would roll back a binary that never ran")
	}
	// Another update meanwhile is busy, not a second download.
	if err := u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err == nil || !strings.Contains(err.Error(), "in progress") {
		t.Fatalf("second update: %v", err)
	}

	unverified.Store(0)
	select {
	case <-f.system.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent did not restart once the deploy was verified")
	}
	if got := readString(t, f.exe); got != string(f.binary) {
		t.Fatalf("installed binary = %q", got)
	}
	f.system.mu.Lock()
	armed = len(f.system.armed)
	f.system.mu.Unlock()
	if armed != 1 {
		t.Fatalf("guard armed %d times", armed)
	}
	if got := f.reports.all(); len(got) != 0 {
		t.Fatalf("reports before the new agent confirmed: %v", got)
	}
}

// The wait is bounded: a deploy that stays unverified does not hold the
// update forever.
func TestAgentUpdateRolloutWaitIsBounded(t *testing.T) {
	fastRolloutPoll(t)
	f := newAgentFixture(t, "1.2.0")
	var unverified atomic.Int64
	unverified.Store(1)
	started := time.Now()
	if err := f.updaterWaiting("1.1.0", &unverified, 100*time.Millisecond).Update(context.Background(),
		f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.system.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never restarted")
	}
	if waited := time.Since(started); waited < 100*time.Millisecond {
		t.Fatalf("restarted after %s, before the wait ended", waited)
	}
	if got := readString(t, f.exe); got != string(f.binary) {
		t.Fatalf("installed binary = %q", got)
	}
}

// A failure after the wait (here: the guard cannot be armed) is reported
// as the update's result, since the request already returned.
func TestAgentUpdateFailureAfterTheWaitIsReported(t *testing.T) {
	fastRolloutPoll(t)
	f := newAgentFixture(t, "1.2.0")
	var unverified atomic.Int64
	unverified.Store(1)
	u := f.updaterWaiting("1.1.0", &unverified, time.Minute)
	u.opts.System = &failingGuard{fakeSystem: f.system}
	if err := u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
		t.Fatal(err)
	}
	unverified.Store(0)
	deadline := time.Now().Add(5 * time.Second)
	for len(f.reports.all()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	got := f.reports.all()
	if len(got) != 1 || got[0].GetSuccess() || !strings.Contains(got[0].GetError(), "guard") || got[0].GetToVersion() != "1.2.0" {
		t.Fatalf("reports = %v", got)
	}
	if !strings.Contains(readString(t, f.exe), "1.1.0") {
		t.Fatal("the binary was swapped although the guard could not be armed")
	}
	// The lock is free again.
	if holder := u.lock.Holder(); holder != "" {
		t.Fatalf("lock still held by %q", holder)
	}
}

type failingGuard struct{ *fakeSystem }

func (failingGuard) ArmGuard(context.Context, string, string, time.Duration) error {
	return errGuard
}

var errGuard = errors.New("arming the update rollback guard: systemd-run failed")
