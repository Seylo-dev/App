package update

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// The 0.2.0 install test race: the panel's update run marks its panel step
// done as soon as the new panel answers and sends UpdateAgent to the panel
// node at once, while the swap still holds the node's update lock for the
// health check and its report. The agent answered busy, the panel waited
// for a version that never came, and the step failed after 10 minutes.
// Now the agent update waits for the swap and goes ahead.
func TestUpdateAgentWaitsForThePanelSwap(t *testing.T) {
	lock := &Lock{}
	f := newAgentFixture(t, "1.2.0")
	u, err := NewAgentUpdater(AgentOptions{DataDir: f.dataDir, Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: f.key.publicText(t),
		GOOS: "linux", GOARCH: "amd64", System: f.system, Report: f.reports.add, RestartDelay: time.Millisecond, BusyWait: 5 * time.Second}, lock)
	if err != nil {
		t.Fatal(err)
	}
	swapper, rt, swapReports, _ := panelFixtureLocked(t, map[string]bool{"panel:new": true}, lock)
	gate := make(chan struct{})
	rt.mu.Lock()
	rt.healthGate = gate
	rt.mu.Unlock()
	if err := swapper.Swap(context.Background(), swapRequest()); err != nil {
		t.Fatal(err)
	}
	// The new panel runs (and reaches the agent) before its health check passed.
	for deadline := time.Now().Add(5 * time.Second); !strings.Contains(rt.Steps(), "start panel:new"); time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the swap never started the new panel: %s", rt.Steps())
		}
	}
	if h := lock.Holder(); h != holdPanelUpdate {
		t.Fatalf("lock holder = %q", h)
	}

	done := make(chan error, 1)
	go func() {
		done <- u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL)))
	}()
	select {
	case err := <-done:
		t.Fatalf("UpdateAgent answered while the swap held the lock: %v (before: busy, and the panel's step timed out)", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(gate)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("UpdateAgent after the swap: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("UpdateAgent never went ahead after the swap released the lock")
	}
	select {
	case <-f.system.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent was not restarted into the new binary")
	}
	if r := waitReport(t, swapReports); !r.GetSuccess() {
		t.Fatalf("panel swap result = %v", r)
	}
}

// Only a panel swap is waited for: the agent's own update, a Docker
// upgrade or a reboot answers busy at once, and the panel tries again.
func TestUpdateAgentBusyAnswersAtOnceForOtherHolders(t *testing.T) {
	for _, holder := range []string{holdAgentUpdate, holdDockerUpdate, holdReboot} {
		lock := &Lock{}
		release, _ := lock.TryAcquire(holder)
		f := newAgentFixture(t, "1.2.0")
		u, _ := NewAgentUpdater(AgentOptions{DataDir: f.dataDir, Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: f.key.publicText(t),
			System: f.system, BusyWait: 5 * time.Second}, lock)
		start := time.Now()
		err := u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL)))
		release()
		if !errors.Is(err, ErrBusy) || !strings.Contains(err.Error(), "("+holder+")") {
			t.Fatalf("%s: err = %v", holder, err)
		}
		if waited := time.Since(start); waited > time.Second {
			t.Fatalf("%s: waited %s for a holder that does not end by itself", holder, waited)
		}
	}
}

// The wait leaves busyReserve of the call's deadline to the download: a
// 0.2.0 panel's 30-second UpdateAgent gets its busy answer at once, the
// 0.2.1 panel's two minutes allow the full wait.
func TestUpdateAgentBusyWaitFitsTheCallDeadline(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	u := f.updater("1.1.0")
	if got := u.busyWait(context.Background()); got != DefaultBusyWait {
		t.Fatalf("no deadline: %s", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if got := u.busyWait(ctx); got != DefaultBusyWait {
		t.Fatalf("2 minutes: %s", got)
	}
	short, cancelShort := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShort()
	if got := u.busyWait(short); got > 0 {
		t.Fatalf("30 seconds: waits %s", got)
	}

	lock := &Lock{}
	release, _ := lock.TryAcquire(holdPanelUpdate)
	defer release()
	u, _ = NewAgentUpdater(AgentOptions{DataDir: f.dataDir, Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: f.key.publicText(t),
		System: f.system}, lock)
	start := time.Now()
	if err := u.Update(short, f.request(testManifest("1.2.0", f.binary, f.server.URL))); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
	if waited := time.Since(start); waited > time.Second {
		t.Fatalf("a 30-second call waited %s for the lock", waited)
	}
}

func TestLockAcquireWithin(t *testing.T) {
	isPanel := func(h string) bool { return h == "panel" }
	l := &Lock{}
	release, _ := l.TryAcquire("panel")
	time.AfterFunc(50*time.Millisecond, release)
	got, holder, ok := l.AcquireWithin(context.Background(), "agent", time.Second, isPanel)
	if !ok || holder != "" || l.Holder() != "agent" {
		t.Fatalf("after release: ok=%v holder=%q now=%q", ok, holder, l.Holder())
	}
	got()

	// The panel swap ends and a Docker update takes the lock before the
	// waiter looks again: it gives up, Docker does not end by itself.
	_, _ = l.TryAcquire("panel")
	time.AfterFunc(20*time.Millisecond, func() {
		l.mu.Lock()
		freed := l.freed
		l.holder, l.freed = "docker", make(chan struct{})
		l.mu.Unlock()
		close(freed)
	})
	if _, holder, ok := l.AcquireWithin(context.Background(), "agent", time.Second, isPanel); ok || holder != "docker" {
		t.Fatalf("taken by docker: ok=%v holder=%q", ok, holder)
	}

	// The context ends first.
	l = &Lock{}
	release, _ = l.TryAcquire("panel")
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, holder, ok := l.AcquireWithin(ctx, "agent", time.Minute, isPanel); ok || holder != "panel" || time.Since(start) > time.Second {
		t.Fatalf("ctx: ok=%v holder=%q after %s", ok, holder, time.Since(start))
	}
	// No wait: like TryAcquire.
	if _, holder, ok := l.AcquireWithin(context.Background(), "agent", 0, isPanel); ok || holder != "panel" {
		t.Fatalf("no wait: ok=%v holder=%q", ok, holder)
	}
}
