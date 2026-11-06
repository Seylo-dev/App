//go:build integration

package reconcile

import (
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// fetchFrom runs wget inside a container: what a neighbour on its project
// network can reach by name.
func (e *itEnv) fetchFrom(container, url string) (string, bool) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, err := e.eng.ExecRun(ctx, container, []string{"wget", "-q", "-T", "2", "-O", "-", url}, 4096)
	if err != nil {
		e.t.Fatalf("exec in %s: %v", container, err)
	}
	return strings.TrimSpace(string(r.Output)), r.ExitCode == 0
}

// TestITMoveProjectReattach moves a running service to another project:
// the same container joins the new project network, answers there, and
// keeps answering through the whole switch (the portgate path, Resolve,
// polled from the host); afterwards only the new project's services reach
// it by name.
func TestITMoveProjectReattach(t *testing.T) {
	e := newIT(t)
	ctx := context.Background()
	id := e.id("web")
	e.apply(1, e.web("web", "p", "hello", 1))
	if p := e.result(id, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("web: %v", p)
	}
	// A neighbour in the old project and one in the new project.
	e.apply(2, e.web("peer", "p", "peer", 1))
	e.apply(3, e.web("other", "q", "other", 1))
	if p := e.result(e.id("peer"), 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("peer: %v", p)
	}
	if p := e.result(e.id("other"), 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("other: %v", p)
	}
	e.settle()
	web := docker.ContainerName(id, 1, 0)
	peer := docker.ContainerName(e.id("peer"), 1, 0)
	other := docker.ContainerName(e.id("other"), 1, 0)
	if got, ok := e.fetchFrom(peer, "http://web:8080/"); !ok || got != "hello" {
		t.Fatalf("peer in the old project: %q %v", got, ok)
	}
	if _, ok := e.fetchFrom(other, "http://web:8080/"); ok {
		t.Fatal("a service of another project reached web before the move")
	}
	before, err := e.eng.InspectContainer(ctx, web)
	if err != nil {
		t.Fatal(err)
	}

	// Poll the service the way the portgate does while it moves.
	var ok, failed atomic.Int64
	var lastErr atomic.Value
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		client := http.Client{Timeout: 2 * time.Second}
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			addr, err := e.rt.Resolve(ctx, id, 8080)
			if err == nil {
				var resp *http.Response
				if resp, err = client.Get("http://" + addr + "/"); err == nil {
					b, _ := io.ReadAll(resp.Body)
					_ = resp.Body.Close()
					if strings.TrimSpace(string(b)) != "hello" {
						err = io.ErrUnexpectedEOF
					}
				}
			}
			if err != nil {
				failed.Add(1)
				lastErr.Store(err.Error())
				continue
			}
			ok.Add(1)
		}
	})
	time.Sleep(300 * time.Millisecond)

	moved := e.web("web", "q", "hello", 2)
	e.apply(4, moved)
	if p := e.result(id, 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("move: %v", p)
	}
	e.settle()
	time.Sleep(500 * time.Millisecond)
	close(stop)
	wg.Wait()
	if failed.Load() != 0 || ok.Load() < 10 {
		t.Fatalf("requests during the move: %d ok, %d failed (last error %v)", ok.Load(), failed.Load(), lastErr.Load())
	}

	after, err := e.eng.InspectContainer(ctx, web)
	if err != nil {
		t.Fatal(err)
	}
	if after.ID != before.ID || !after.Running || !after.StartedAt.Equal(before.StartedAt) {
		t.Fatalf("the container was recreated or restarted: before %s %s, after %s %s", before.ID, before.StartedAt, after.ID, after.StartedAt)
	}
	var nets []string
	for n := range after.Networks {
		nets = append(nets, n)
	}
	if !slices.Equal(nets, []string{docker.ProjectNetwork(e.prefix + "q")}) {
		t.Fatalf("networks after the move = %v", nets)
	}
	if got, ok := e.fetchFrom(other, "http://web:8080/"); !ok || got != "hello" {
		t.Fatalf("other in the new project: %q %v", got, ok)
	}
	if _, ok := e.fetchFrom(peer, "http://web:8080/"); ok {
		t.Fatal("the old project still reaches web after the move")
	}
	if st := e.state.get(id); st.GetPhase() != agentv1.ServicePhase_SERVICE_PHASE_RUNNING || st.GetGeneration() != 2 {
		t.Fatalf("status = %v", st)
	}

	// An agent restart keeps the moved container where it is.
	e.stop()
	e.start()
	e.settle()
	if list := e.containers(id); len(list) != 1 || list[0].ID != before.ID {
		t.Fatalf("after an agent restart: %+v", list)
	}
	if got, ok := e.fetchFrom(other, "http://web:8080/"); !ok || got != "hello" {
		t.Fatalf("after an agent restart: %q %v", got, ok)
	}
}

// networkNames returns the networks a container is on, sorted.
func (e *itEnv) networkNames(container string) []string {
	e.t.Helper()
	d, err := e.eng.InspectContainer(context.Background(), container)
	if err != nil {
		e.t.Fatal(err)
	}
	var out []string
	for n := range d.Networks {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}

// TestITMoveProjectInterruptedLeavesTheOldNetwork stops the agent after a
// move is recorded but before the container left the old project's
// network: the next start takes it off, so the old project no longer
// reaches it and its network can go.
func TestITMoveProjectInterruptedLeavesTheOldNetwork(t *testing.T) {
	e := newIT(t)
	e.stop()
	e.drain = time.Hour
	e.start()
	ctx := context.Background()
	id := e.id("web")
	e.apply(1, e.web("web", "p", "hello", 1))
	e.apply(2, e.web("peer", "p", "peer", 1))
	for _, s := range []string{id, e.id("peer")} {
		if p := e.result(s, 1); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
			t.Fatalf("%s: %v", s, p)
		}
	}
	e.settle()
	web := docker.ContainerName(id, 1, 0)
	peer := docker.ContainerName(e.id("peer"), 1, 0)
	before, err := e.eng.InspectContainer(ctx, web)
	if err != nil {
		t.Fatal(err)
	}

	e.apply(3, e.web("web", "q", "hello", 2))
	deadline := time.Now().Add(time.Minute)
	for {
		if _, ok := e.rt.reattached.Load(before.ID); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the move was never recorded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	e.stop()
	oldNet, newNet := docker.ProjectNetwork(e.prefix+"p"), docker.ProjectNetwork(e.prefix+"q")
	if got := e.networkNames(web); !slices.Equal(got, []string{oldNet, newNet}) {
		t.Fatalf("networks while stopped mid-drain = %v", got)
	}

	e.drain = 0
	e.start()
	e.settle()
	if p := e.result(id, 2); p.GetStage() != agentv1.DeployStage_DEPLOY_STAGE_SUCCEEDED {
		t.Fatalf("move: %v", p)
	}
	if got := e.networkNames(web); !slices.Equal(got, []string{newNet}) {
		t.Fatalf("networks after the restart = %v", got)
	}
	after, err := e.eng.InspectContainer(ctx, web)
	if err != nil || after.ID != before.ID || !after.StartedAt.Equal(before.StartedAt) {
		t.Fatalf("the container was recreated or restarted: %v", err)
	}
	if _, ok := e.fetchFrom(peer, "http://web:8080/"); ok {
		t.Fatal("the old project still reaches web after the restart")
	}
}
