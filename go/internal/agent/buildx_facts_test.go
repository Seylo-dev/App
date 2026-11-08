package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeBuildx answers `docker buildx version` from a script of results and
// counts the runs.
type fakeBuildx struct {
	mu   sync.Mutex
	out  string
	err  error
	hang bool
	runs int
	ran  chan struct{}
}

func newFakeBuildx(out string, err error) *fakeBuildx {
	return &fakeBuildx{out: out, err: err, ran: make(chan struct{}, 100)}
}

func (f *fakeBuildx) set(out string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.out, f.err = out, err
}

func (f *fakeBuildx) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runs
}

func (f *fakeBuildx) version(ctx context.Context) (string, error) {
	f.mu.Lock()
	f.runs++
	out, err, hang := f.out, f.err, f.hang
	f.mu.Unlock()
	// A wake-up for waitRuns; it polls the count, so a full buffer loses nothing.
	defer func() {
		select {
		case f.ran <- struct{}{}:
		default:
		}
	}()
	if hang {
		<-ctx.Done()
		return "", ctx.Err()
	}
	return out, err
}

// waitRuns waits until the fake ran n times in all.
func (f *fakeBuildx) waitRuns(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for f.count() < n {
		select {
		case <-f.ran:
		case <-deadline:
			t.Fatalf("buildx ran %d times, want %d", f.count(), n)
		}
	}
}

const buildxOutput = "github.com/docker/buildx v0.29.1 a8f2c4e\n"

func TestBuildxFactsCheck(t *testing.T) {
	d, rec := newTestDeps(t)
	fake := newFakeBuildx(buildxOutput, nil)
	bx := newBuildxFacts(d, fake.version)

	installed, known := bx.check(context.Background())
	if !installed || !known {
		t.Fatalf("check = %v, %v", installed, known)
	}
	got := d.Facts.Get().GetBuildx()
	if !proto.Equal(got, &agentv1.BuildxInfo{Installed: true, Version: "v0.29.1"}) {
		t.Fatalf("facts.buildx = %v", got)
	}
	// The panel hears about it as a node_facts event.
	rec.WaitEmitted(t, func(e *agentv1.Event) bool { return e.GetNodeFacts().GetBuildx().GetVersion() == "v0.29.1" })

	// Missing: the command fails (no plugin, or no docker at all).
	fake.set("", errors.New(`docker: 'buildx' is not a docker command`))
	installed, known = bx.check(context.Background())
	if installed || !known {
		t.Fatalf("check = %v, %v", installed, known)
	}
	if got := d.Facts.Get().GetBuildx(); !proto.Equal(got, &agentv1.BuildxInfo{Installed: false}) {
		t.Fatalf("facts.buildx = %v", got)
	}

	// A run that times out teaches nothing: the last answer stays.
	fake.set(buildxOutput, nil)
	bx.check(context.Background())
	fake.mu.Lock()
	fake.hang = true
	fake.mu.Unlock()
	bx.timeout = 20 * time.Millisecond
	if installed, known = bx.check(context.Background()); known {
		t.Fatalf("a timed out run must not count: %v, %v", installed, known)
	}
	if !d.Facts.Get().GetBuildx().GetInstalled() {
		t.Fatal("a timeout replaced the last answer")
	}

	// The agent stopping in the middle changes nothing either.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	bx.timeout = time.Minute
	if _, known = bx.check(ctx); known {
		t.Fatal("a cancelled run must not count")
	}
}

func TestBuildxFactsLoop(t *testing.T) {
	d, _ := newTestDeps(t)
	fake := newFakeBuildx("", errors.New("not installed"))
	bx := newBuildxFacts(d, fake.version)
	bx.every, bx.missingEvery = time.Hour, 10*time.Millisecond
	builds := false
	var mu sync.Mutex
	bx.buildsOn = func() bool { mu.Lock(); defer mu.Unlock(); return builds }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- bx.run(ctx) }()

	// At start, then nothing for the 30 minutes (here: an hour) while builds are off.
	fake.waitRuns(t, 1)
	time.Sleep(50 * time.Millisecond)
	if n := fake.count(); n != 1 {
		t.Fatalf("builds off: ran %d times", n)
	}

	// Recheck runs it now; with builds on and buildx missing it keeps checking every minute (here 10ms).
	mu.Lock()
	builds = true
	mu.Unlock()
	bx.Recheck()
	fake.waitRuns(t, 4)

	// Installed: back to the slow pace.
	fake.set(buildxOutput, nil)
	fake.waitRuns(t, fake.count()+1)
	time.Sleep(50 * time.Millisecond)
	settled := fake.count()
	time.Sleep(50 * time.Millisecond)
	if fake.count() != settled {
		t.Fatalf("installed: still checking fast (%d -> %d)", settled, fake.count())
	}
	if !d.Facts.Get().GetBuildx().GetInstalled() {
		t.Fatal("facts did not follow the install")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the loop did not stop")
	}
}

func TestWireBuildxFactsRechecksWhenBuildsTurnOn(t *testing.T) {
	d, _ := newTestDeps(t)
	d.Feed.Publish(&agentv1.DesiredState{Revision: 1, Settings: &agentv1.NodeSettings{MaxParallelBuilds: 0}})
	fake := newFakeBuildx(buildxOutput, nil)
	bx := wireBuildxFacts(d, fake.version)
	bx.every = time.Hour
	found := false
	for _, c := range d.Components.List() {
		found = found || c.Name == "buildx-facts"
	}
	if !found {
		t.Fatal("no buildx-facts component")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = bx.run(ctx) }()
	fake.waitRuns(t, 1)

	// The panel turns Can build on: check again right away.
	d.Feed.Publish(&agentv1.DesiredState{Revision: 2, Settings: &agentv1.NodeSettings{MaxParallelBuilds: 2}})
	fake.waitRuns(t, 2)
	// Other changes while on (and turning it off) do not.
	d.Feed.Publish(&agentv1.DesiredState{Revision: 3, Settings: &agentv1.NodeSettings{MaxParallelBuilds: 4}})
	d.Feed.Publish(&agentv1.DesiredState{Revision: 4, Settings: &agentv1.NodeSettings{MaxParallelBuilds: 0}})
	time.Sleep(50 * time.Millisecond)
	if n := fake.count(); n != 2 {
		t.Fatalf("ran %d times, want 2", n)
	}
}

func TestBuildxVersion(t *testing.T) {
	for _, tc := range []struct{ out, want string }{
		{"github.com/docker/buildx v0.29.1 a8f2c4e\n", "v0.29.1"},
		{"github.com/docker/buildx 0.13.1+ds1-3 \n", "0.13.1+ds1-3"},
		{"\n  buildx-dev  \nmore\n", "buildx-dev"},
		{"", ""},
		{"github.com/docker/buildx v1\x00\x072 x", "v12"},
		{"x " + strings.Repeat("9", 200), strings.Repeat("9", maxBuildxVersionLen)},
		{"x v0.1é2", "v0.12"},
	} {
		if got := buildxVersion(tc.out); got != tc.want {
			t.Errorf("buildxVersion(%q) = %q, want %q", tc.out, got, tc.want)
		}
	}
}

func TestBuildsOnAndStoredSettings(t *testing.T) {
	if BuildsOn(false, nil) || BuildsOn(false, &agentv1.NodeSettings{}) {
		t.Fatal("no builds without the panel or config.yml")
	}
	if !BuildsOn(true, nil) || !BuildsOn(false, &agentv1.NodeSettings{MaxParallelBuilds: 1}) {
		t.Fatal("either one turns builds on")
	}

	d, _ := newTestDeps(t)
	if StoredSettings(d.Layout) != nil {
		t.Fatal("no desired.pb yet")
	}
	path := filepath.Join(d.Layout.StateDir(), "desired.pb")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := proto.Marshal(&agentv1.DesiredState{Revision: 3, Settings: &agentv1.NodeSettings{MaxParallelBuilds: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := StoredSettings(d.Layout).GetMaxParallelBuilds(); got != 2 {
		t.Fatalf("max_parallel_builds = %d", got)
	}
	// An unreadable file gives nothing and stays where it is: only the agent moves it aside.
	if err := os.WriteFile(path, []byte("\xff\xff\xff"), 0o600); err != nil {
		t.Fatal(err)
	}
	if StoredSettings(d.Layout) != nil {
		t.Fatal("garbage decoded")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the file moved: %v", err)
	}
}
