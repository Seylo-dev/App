package reconcile

import (
	"context"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker/dockertest"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

type fakeCloudflare struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeCloudflare) Sync(_ context.Context, id, target string, spec *agentv1.CloudflareTunnel) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	state := "off"
	if spec.GetEnabled() {
		state = "on"
	}
	f.calls = append(f.calls, state+":"+target)
	return "", nil
}

func (f *fakeCloudflare) URL(id string) string { return "https://" + id + ".trycloudflare.com" }

func (f *fakeCloudflare) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return ""
	}
	return f.calls[len(f.calls)-1]
}

func TestCloudflareTunnelFollowsService(t *testing.T) {
	eng := dockertest.New()
	cf := &fakeCloudflare{}
	st := newMemState()
	rec := rpctest.NewRecorder()
	rt, err := New(Options{
		Docker: eng, Prober: &fakeProber{eng: eng, bad: map[string]bool{}}, Crash: crash.NewTracker(nil),
		Layout: datadir.New(t.TempDir()), Cloudflare: cf, State: st, Reports: rec,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- rt.Run(ctx) }()
	defer func() { cancel(); <-done }()
	h := &harness{t: t, eng: eng, rt: rt, rec: rec, state: st}
	h.waitFor("started", func() bool { rt.mu.Lock(); defer rt.mu.Unlock(); return rt.runCtx != nil })

	s := appSpec("svc", 1, "app:v1")
	s.DevAccess = &agentv1.DevAccess{CloudflareTunnel: &agentv1.CloudflareTunnel{Enabled: true}}
	h.apply(1, s)
	h.deployResult("svc", 1)
	if got := cf.last(); !strings.HasPrefix(got, "on:10.99.") || !strings.HasSuffix(got, ":80") {
		t.Fatalf("tunnel = %q", got)
	}
	h.waitFor("tunnel url in status", func() bool {
		return st.get("svc").GetTunnelUrl() == "https://svc.trycloudflare.com"
	})
	// Stopped: the tunnel goes.
	h.apply(2, cloneSpec(s, 2, func(s *agentv1.ServiceSpec) { s.Stopped = true }))
	if got := cf.last(); got != "off:" {
		t.Fatalf("stopped tunnel = %q", got)
	}
	// Removed while off: no extra call.
	n := len(cf.calls)
	if _, err := rt.Remove(context.Background(), 3, "svc", false); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if len(cf.calls) != n+1 || cf.last() != "off:" {
		t.Fatalf("calls = %v", cf.calls)
	}
}
