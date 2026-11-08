package jobrun

import (
	"context"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

type fakeHelpers struct {
	mu      sync.Mutex
	ensures atomic.Int32
	stops   []string
	running []Container
	gate    chan struct{}
}

func (f *fakeHelpers) EnsureRunning(ctx context.Context, spec Spec) (Container, error) {
	f.ensures.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	return Container{Name: spec.Name, Running: true, IPs: map[string]netip.Addr{spec.Network: netip.MustParseAddr("10.0.0.7")}}, nil
}

func (f *fakeHelpers) Stop(ctx context.Context, name string, grace time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, name)
	return nil
}

func (f *fakeHelpers) ListContainers(ctx context.Context, labels map[string]string) ([]Container, error) {
	return f.running, nil
}

func TestOnDemandWakeTouchReap(t *testing.T) {
	f := &fakeHelpers{gate: make(chan struct{})}
	o := NewOnDemand(f, nil)
	o.Ready = func(context.Context, string) error { return nil }
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var clockMu sync.Mutex
	o.Now = func() time.Time { clockMu.Lock(); defer clockMu.Unlock(); return now }
	advance := func(d time.Duration) { clockMu.Lock(); now = now.Add(d); clockMu.Unlock() }

	target := Target{Spec: Spec{Name: "seylo-db1-db-ui", Network: "seylo-p-p1"}, Port: 8081, Network: "seylo-p-p1", Idle: 10 * time.Minute}
	// Two concurrent wakes share one start.
	results := make(chan string, 2)
	for range 2 {
		go func() {
			u, err := o.Wake(context.Background(), target)
			if err != nil {
				t.Error(err)
			}
			results <- u
		}()
	}
	time.Sleep(20 * time.Millisecond)
	if _, starting := o.State(target.Spec.Name); !starting {
		t.Fatal("not starting during wake")
	}
	close(f.gate)
	for range 2 {
		if u := <-results; u != "http://10.0.0.7:8081" {
			t.Fatalf("upstream = %q", u)
		}
	}
	if n := f.ensures.Load(); n != 1 {
		t.Fatalf("EnsureRunning called %d times", n)
	}
	if running, _ := o.State(target.Spec.Name); !running {
		t.Fatal("not running after wake")
	}

	advance(9 * time.Minute)
	o.Touch(target.Spec.Name)
	advance(9 * time.Minute)
	o.Reap(context.Background())
	if len(f.stops) != 0 {
		t.Fatalf("stopped despite touch: %v", f.stops)
	}
	advance(2 * time.Minute)
	o.Reap(context.Background())
	if len(f.stops) != 1 || f.stops[0] != target.Spec.Name {
		t.Fatalf("stops = %v", f.stops)
	}
	if running, _ := o.State(target.Spec.Name); running {
		t.Fatal("still running after reap")
	}
	// Reaping again does not stop twice.
	o.Reap(context.Background())
	if len(f.stops) != 1 {
		t.Fatalf("stops = %v", f.stops)
	}
}

func TestOnDemandAdoptsRunningHelpers(t *testing.T) {
	f := &fakeHelpers{running: []Container{
		{Name: "seylo-a-box", Running: true, Labels: map[string]string{docker.LabelRole: RoleBox}},
		{Name: "seylo-b-box", Running: false},
	}}
	o := NewOnDemand(f, nil)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	o.Now = func() time.Time { return now }
	if err := o.Adopt(context.Background(), RoleBox, time.Minute); err != nil {
		t.Fatal(err)
	}
	o.Reap(context.Background())
	if len(f.stops) != 0 {
		t.Fatal("adopted helper stopped right away")
	}
	now = now.Add(2 * time.Minute)
	o.Reap(context.Background())
	if len(f.stops) != 1 || f.stops[0] != "seylo-a-box" {
		t.Fatalf("stops = %v", f.stops)
	}
}

func TestImageRefAndTail(t *testing.T) {
	cases := map[[2]string]string{
		{"nginx:1.27", "sha256:a"}:                  "nginx:1.27@sha256:a",
		{"127.0.0.1:5755/svc:3", "sha256:b"}:        "127.0.0.1:5755/svc:3@sha256:b",
		{"127.0.0.1:5755/svc", "sha256:b"}:          "127.0.0.1:5755/svc@sha256:b",
		{"ghcr.io/a/b:1", ""}:                       "ghcr.io/a/b:1",
		{"ghcr.io/a/b@sha256:c", "sha256:c"}:        "ghcr.io/a/b@sha256:c",
		{"registry:5000/x/y:latest", "sha256:dddd"}: "registry:5000/x/y:latest@sha256:dddd",
	}
	for in, want := range cases {
		if got := ImageRef(imageRef(in[0], in[1])); got != want {
			t.Errorf("ImageRef(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}

	tail := NewTail(3, []string{"hunter22", "ab"})
	_, _ = tail.Write([]byte("one\ntwo hunter22\nthree\nfour"))
	_, _ = tail.Write([]byte(" more\nab five\n"))
	got := tail.Lines()
	want := []string{"three", "four more", "ab five"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("tail = %q", got)
	}
	tail2 := NewTail(5, []string{"hunter22"})
	_, _ = tail2.Write([]byte("pw=hunter22\n"))
	if l := tail2.Lines(); l[0] != "pw=[redacted]" {
		t.Fatalf("redaction = %q", l)
	}
}

func TestLabelsAlwaysManaged(t *testing.T) {
	l := Labels(Owner{ServiceID: "s", ProjectID: "p", Kind: "app"}, RoleCron, map[string]string{
		docker.LabelManaged: "false", docker.LabelTraefikEnable: "true", "x": "y",
	})
	if l[docker.LabelManaged] != "true" || l[docker.LabelTraefikEnable] != "false" || l[docker.LabelRole] != RoleCron || l["x"] != "y" || l[docker.LabelService] != "s" {
		t.Fatalf("labels = %v", l)
	}
	a := Spec{Image: "x", Env: []string{"B=2", "A=1"}, Labels: l}
	b := Spec{Image: "x", Env: []string{"A=1", "B=2"}, Labels: l}
	if SpecHash(a) != SpecHash(b) {
		t.Fatal("hash depends on env order")
	}
	b.Image = "y"
	if SpecHash(a) == SpecHash(b) {
		t.Fatal("hash ignores the image")
	}
}

func imageRef(ref, digest string) *agentv1.ImageRef {
	return &agentv1.ImageRef{Reference: ref, Digest: digest}
}

func TestOnDemandInfoAndChanges(t *testing.T) {
	f := &fakeHelpers{}
	o := NewOnDemand(f, nil)
	o.Ready = func(context.Context, string) error { return nil }
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	o.Now = func() time.Time { return now }
	changes := make(chan string, 4)
	o.OnChange = func(name string) { changes <- name }
	wait := func(what string) {
		t.Helper()
		select {
		case n := <-changes:
			if n != "ui" {
				t.Fatalf("%s: change of %q", what, n)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: no change", what)
		}
	}
	if running, _, _ := o.Info("ui"); running {
		t.Fatal("unknown helper reported running")
	}
	target := Target{Spec: Spec{Name: "ui", Network: "n"}, Port: 80, Network: "n", Idle: time.Minute}
	if _, err := o.Wake(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	wait("start")
	if running, started, last := o.Info("ui"); !running || !started.Equal(now) || !last.Equal(now) {
		t.Fatalf("info = %v %v %v", running, started, last)
	}
	// A second wake of a running helper is not a change.
	if _, err := o.Wake(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	o.Reap(context.Background())
	wait("idle stop")
	if running, _, _ := o.Info("ui"); running {
		t.Fatal("reaped helper still running")
	}
	select {
	case n := <-changes:
		t.Fatalf("unexpected change %q", n)
	default:
	}
}
