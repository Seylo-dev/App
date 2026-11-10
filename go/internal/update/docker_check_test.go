package update

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// checkClock hands out RunChecks' timers; the test fires them, which moves
// the clock to their deadline.
type checkClock struct {
	mu     sync.Mutex
	now    time.Time
	timers chan checkTimer
}

type checkTimer struct {
	d  time.Duration
	at time.Time
	ch chan time.Time
}

func newCheckClock(now time.Time) *checkClock {
	return &checkClock{now: now, timers: make(chan checkTimer, 4)}
}

func (c *checkClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *checkClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.timers <- checkTimer{d: d, at: c.Now().Add(d), ch: ch}
	return ch
}

func (c *checkClock) set(t time.Time) {
	c.mu.Lock()
	c.now = t
	c.mu.Unlock()
}

// next waits for the loop's next timer: it set one, so whatever it did
// before is done.
func (c *checkClock) next(t *testing.T) checkTimer {
	t.Helper()
	select {
	case tm := <-c.timers:
		return tm
	case <-time.After(5 * time.Second):
		t.Fatal("RunChecks set no timer")
		return checkTimer{}
	}
}

// fire moves the clock to the timer's deadline (unless it is past it) and fires it.
func (c *checkClock) fire(tm checkTimer) {
	if tm.at.After(c.Now()) {
		c.set(tm.at)
	}
	tm.ch <- c.Now()
}

// findings records what went to DockerOptions.Checked.
type findings struct {
	mu   sync.Mutex
	list []*agentv1.DockerUpdateInfo
}

func (f *findings) add(info *agentv1.DockerUpdateInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.list = append(f.list, info)
}

func (f *findings) all() []*agentv1.DockerUpdateInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*agentv1.DockerUpdateInfo(nil), f.list...)
}

func aptOnly(name string) bool { return name == "apt-get" || name == "dpkg-query" }

// aptScript is a node with docker-ce 27.3.1 from Docker's repository and 28.0.1 available.
func aptScript() *scripted {
	return &scripted{answers: map[string]string{
		"dpkg-query -W -f=${Status} docker-ce": "install ok installed",
		"dpkg-query":                           "!fail",
		"apt-get update":                       "",
		"apt-cache policy docker-ce":           aptPolicy,
		"env DEBIAN_FRONTEND":                  "",
		"docker version":                       "28.0.1\n",
	}}
}

// upgraded reports a command that changes packages; checks never run one.
func upgraded(calls []string) string {
	for _, c := range calls {
		if strings.HasPrefix(c, "env ") || strings.Contains(c, " install ") || strings.Contains(c, " upgrade") {
			return c
		}
	}
	return ""
}

func TestDockerCheckReportsWithoutUpgrading(t *testing.T) {
	start := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	sc := aptScript()
	found := &findings{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Now: func() time.Time { return start }, Checked: found.add}, &Lock{})

	info, err := d.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.GetInstalled() != "27.3.1" || info.GetCandidate() != "28.0.1" || info.GetPackageManager() != "apt" || !info.GetUpdatable() ||
		info.GetReason() != "" || !info.GetCheckedAt().AsTime().Equal(start) {
		t.Fatalf("finding = %v", info)
	}
	if got := found.all(); len(got) != 1 || got[0] != info {
		t.Fatalf("Checked got %v", got)
	}
	// The same refresh as a dry run, and nothing installed.
	if sc.count("apt-get update -qq") != 1 || sc.count("apt-cache policy docker-ce") != 1 {
		t.Fatalf("commands = %v", sc.ran())
	}
	if c := upgraded(sc.ran()); c != "" {
		t.Fatalf("the check ran %q", c)
	}
	if h := d.lock.Holder(); h != "" {
		t.Fatalf("the lock is still held by %q", h)
	}
}

func TestDockerCheckNotFromAPackageManager(t *testing.T) {
	// Static binaries or snap: no docker-ce or docker.io package.
	sc := &scripted{answers: map[string]string{"dpkg-query": "!fail"}}
	found := &findings{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Checked: found.add}, &Lock{})
	info, err := d.Check(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.GetUpdatable() || info.GetInstalled() != "" || info.GetCandidate() != "" || info.GetPackageManager() != "apt" ||
		!strings.Contains(info.GetReason(), "not installed with apt") {
		t.Fatalf("finding = %v", info)
	}
	if sc.count("apt-get") != 0 {
		t.Fatalf("refreshed the lists for a Docker apt does not manage: %v", sc.ran())
	}

	// No package manager at all.
	d = NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: func(string) bool { return false }, Checked: found.add}, &Lock{})
	info, err = d.Check(context.Background())
	if err != nil || info.GetUpdatable() || info.GetPackageManager() != "" || !strings.Contains(info.GetReason(), "no package manager") {
		t.Fatalf("finding = %v, %v", info, err)
	}
	// UpdateDocker refuses both as before, and also reports what it found.
	if _, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true}); !errors.Is(err, ErrRejected) ||
		!strings.Contains(err.Error(), "no supported package manager") {
		t.Fatalf("dry run = %v", err)
	}
	if got := found.all(); len(got) != 3 || got[2].GetUpdatable() {
		t.Fatalf("findings = %v", got)
	}
}

func TestDockerCheckFailureKeepsTheLastFinding(t *testing.T) {
	sc := aptScript()
	sc.set("apt-get update", "!fail")
	found := &findings{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Checked: found.add}, &Lock{})
	if _, err := d.Check(context.Background()); err == nil || errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
	if got := found.all(); len(got) != 0 {
		t.Fatalf("a failed check reported %v", got)
	}
}

func TestDockerCheckSkipsWhileAnUpdateRuns(t *testing.T) {
	for _, holder := range []string{holdDockerUpdate, holdAgentUpdate, holdPanelUpdate, holdReboot} {
		sc := aptScript()
		found := &findings{}
		lock := &Lock{}
		release, _ := lock.TryAcquire(holder)
		d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Checked: found.add}, lock)
		if _, err := d.Check(context.Background()); !errors.Is(err, ErrBusy) {
			t.Fatalf("%s: err = %v", holder, err)
		}
		if len(sc.ran()) != 0 || len(found.all()) != 0 {
			t.Fatalf("%s: the check ran %v", holder, sc.ran())
		}
		if lock.Holder() != holder {
			t.Fatalf("%s: holder = %q", holder, lock.Holder())
		}
		release()
	}
}

func TestDockerCheckGivesWayToAnUpdate(t *testing.T) {
	sc := aptScript()
	sc.set("apt-get update", "!block")
	found := &findings{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Checked: found.add}, &Lock{})
	checked := make(chan error, 1)
	go func() {
		_, err := d.Check(context.Background())
		checked <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); d.lock.Holder() != holdDockerCheck || sc.count("apt-get update") == 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the check never started")
		}
	}
	// A person's dry run comes in while apt refreshes for the check: the
	// check stops and the dry run goes ahead instead of answering busy.
	sc.set("apt-get update", "")
	res, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true})
	if err != nil || res.GetToVersion() != "28.0.1" {
		t.Fatalf("dry run = %v, %v", res, err)
	}
	select {
	case err := <-checked:
		if !errors.Is(err, ErrBusy) {
			t.Fatalf("check = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the check never returned")
	}
	// Only the dry run reported.
	if got := found.all(); len(got) != 1 || got[0].GetCandidate() != "28.0.1" {
		t.Fatalf("findings = %v", got)
	}
}

func TestDockerChecksSchedule(t *testing.T) {
	start := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	clock := newCheckClock(start)
	sc := aptScript()
	found := &findings{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: aptOnly, Now: clock.Now, After: clock.After, Checked: found.add}, &Lock{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.RunChecks(ctx) }()
	refreshes := func() int { return sc.count("apt-get update") }
	expectNext := func(want time.Duration, wantRefreshes int) checkTimer {
		t.Helper()
		tm := clock.next(t)
		if tm.d != want || refreshes() != wantRefreshes {
			t.Fatalf("next check in %v after %d refreshes, want %v after %d", tm.d, refreshes(), want, wantRefreshes)
		}
		return tm
	}

	// Shortly after the start, not at once.
	tm := expectNext(2*time.Minute, 0)
	clock.fire(tm)
	tm = expectNext(24*time.Hour, 1)
	if got := found.all(); len(got) != 1 || got[0].GetCandidate() != "28.0.1" || !got[0].GetCheckedAt().AsTime().Equal(start.Add(2*time.Minute)) {
		t.Fatalf("findings = %v", got)
	}

	// Half a day later a person's dry run looks again: the next check is a
	// day after that one, not after the last check.
	clock.set(clock.Now().Add(12 * time.Hour))
	if _, err := d.Update(ctx, &agentv1.UpdateDockerRequest{DryRun: true}); err != nil {
		t.Fatal(err)
	}
	clock.fire(tm)
	tm = expectNext(12*time.Hour, 2)
	clock.fire(tm)
	tm = expectNext(24*time.Hour, 3)

	// While an update holds the lock the check waits 15 minutes and reports nothing.
	release, _ := d.lock.TryAcquire(holdDockerUpdate)
	clock.fire(tm)
	tm = expectNext(15*time.Minute, 3)
	release()
	clock.fire(tm)
	tm = expectNext(24*time.Hour, 4)
	reported := len(found.all())

	// A failed check keeps the last finding and tries again sooner, backing off.
	sc.set("apt-get update", "!fail")
	clock.fire(tm)
	tm = expectNext(time.Hour, 5)
	clock.fire(tm)
	tm = expectNext(2*time.Hour, 6)
	if len(found.all()) != reported {
		t.Fatalf("a failed check reported: %v", found.all())
	}
	sc.set("apt-get update", "")
	clock.fire(tm)
	expectNext(24*time.Hour, 7)
	if len(found.all()) != reported+1 {
		t.Fatalf("findings = %v", found.all())
	}

	// Never an upgrade.
	if c := upgraded(sc.ran()); c != "" {
		t.Fatalf("a check ran %q", c)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunChecks did not stop")
	}
}

func TestDockerUpgradeReportsTheNewVersion(t *testing.T) {
	sc := aptScript()
	found := &findings{}
	rep := &reports{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, Report: rep.add, LookPath: aptOnly, Checked: found.add}, &Lock{})
	if _, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{UpdateId: "d1"}); err != nil {
		t.Fatal(err)
	}
	if r := waitReport(t, rep); !r.GetSuccess() {
		t.Fatalf("result = %v", r)
	}
	// What the plan found, then what is installed once the upgrade is done.
	got := found.all()
	if len(got) != 2 || got[0].GetInstalled() != "27.3.1" || got[1].GetInstalled() != "28.0.1" || got[1].GetCandidate() != "28.0.1" {
		t.Fatalf("findings = %v", got)
	}
}

func TestLockGivesWayOnlyToTheYieldingHolder(t *testing.T) {
	l := &Lock{}
	stopped := make(chan struct{})
	release, ok := l.TryAcquireYielding(holdDockerCheck, func() { close(stopped) })
	if !ok {
		t.Fatal("the yielding holder did not get the free lock")
	}
	go func() {
		<-stopped
		release()
	}()
	// A reboot stops the check and goes ahead.
	reboot, ok := l.TryAcquire(holdReboot)
	if !ok || l.Holder() != holdReboot {
		t.Fatalf("reboot: ok %v, holder %q", ok, l.Holder())
	}
	// The check never takes the lock from anyone.
	if _, ok := l.TryAcquireYielding(holdDockerCheck, func() {}); ok {
		t.Fatal("the check took the lock from the reboot")
	}
	reboot()

	// A check that does not stop in time leaves the operation busy.
	defer func(old time.Duration) { yieldWait = old }(yieldWait)
	yieldWait = 20 * time.Millisecond
	stuck, _ := l.TryAcquireYielding(holdDockerCheck, func() {})
	if _, holder, ok := l.AcquireWithin(context.Background(), holdAgentUpdate, time.Second, panelSwapHolds); ok || holder != holdDockerCheck {
		t.Fatalf("ok %v, holder %q", ok, holder)
	}
	stuck()
	if _, ok := l.TryAcquire(holdAgentUpdate); !ok {
		t.Fatal("the lock stayed held")
	}
}
