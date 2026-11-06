package box

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

type fakeRuntime struct {
	mu    sync.Mutex
	calls []string
	awake bool
}

func (f *fakeRuntime) SetSleeping(ctx context.Context, id string, sleeping bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if sleeping {
		f.calls = append(f.calls, "sleep:"+id)
	} else {
		f.calls = append(f.calls, "wake:"+id)
	}
	f.awake = !sleeping
	return nil
}

func (f *fakeRuntime) Resolve(ctx context.Context, id string, port uint32) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.awake {
		return "", errors.New("not running")
	}
	return "10.1.0.2:8080", nil
}

func boxSpec() *agentv1.ServiceSpec {
	return &agentv1.ServiceSpec{
		Id: "bx", ProjectId: "p1", Name: "dev", Kind: agentv1.ServiceKind_SERVICE_KIND_BOX,
		Volumes:  []*agentv1.VolumeMount{{Name: "home", ContainerPath: "/home/coder"}},
		KindSpec: &agentv1.ServiceSpec_Box{Box: &agentv1.BoxSpec{WorkspaceVolume: "home", IdleTimeout: durationpb.New(5 * time.Minute)}},
	}
}

func TestBoxSleepsWhenIdleAndWakes(t *testing.T) {
	rt := &fakeRuntime{awake: true}
	layout := datadir.New(t.TempDir())
	b := New(rt, layout, nil)
	b.ready = func(context.Context, string) error { return nil }
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	b.now = func() time.Time { return now }
	b.Sync([]*agentv1.ServiceSpec{boxSpec(), {Id: "app", Kind: agentv1.ServiceKind_SERVICE_KIND_APP}})
	if !slices.Equal(b.IDs(), []string{"bx"}) {
		t.Fatalf("ids = %v", b.IDs())
	}

	now = now.Add(4 * time.Minute)
	b.Reap(context.Background())
	if len(rt.calls) != 0 {
		t.Fatalf("slept too early: %v", rt.calls)
	}
	// An editor heartbeat in the workspace volume counts as activity.
	vol, _ := layout.ServiceVolume("bx", "home")
	hb := filepath.Join(vol, ".local/share/code-server/heartbeat")
	if err := os.MkdirAll(filepath.Dir(hb), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hb, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(hb, now, now); err != nil {
		t.Fatal(err)
	}
	now = now.Add(4 * time.Minute)
	b.Reap(context.Background())
	if len(rt.calls) != 0 {
		t.Fatalf("slept despite heartbeat: %v", rt.calls)
	}
	now = now.Add(2 * time.Minute)
	b.Reap(context.Background())
	if !slices.Equal(rt.calls, []string{"sleep:bx"}) {
		t.Fatalf("calls = %v", rt.calls)
	}

	up, err := b.Upstream(context.Background(), "bx")
	if err != nil || up != "http://10.1.0.2:8080" {
		t.Fatalf("Upstream = %q, %v", up, err)
	}
	if !slices.Equal(rt.calls, []string{"sleep:bx", "wake:bx"}) {
		t.Fatalf("calls = %v", rt.calls)
	}
	if _, err := b.Upstream(context.Background(), "app"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("app Upstream err = %v", err)
	}
	stopped := boxSpec()
	stopped.Stopped = true
	b.Sync([]*agentv1.ServiceSpec{stopped})
	if _, err := b.Upstream(context.Background(), "bx"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stopped Upstream err = %v", err)
	}
}
