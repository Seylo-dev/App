package nodecheck

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
)

// filterDocker records the filters each container list asked for.
type filterDocker struct {
	DockerAPI
	mu      sync.Mutex
	filters []map[string][]string
}

func (d *filterDocker) Containers(ctx context.Context, filters map[string][]string) ([]DockerContainer, error) {
	d.mu.Lock()
	d.filters = append(d.filters, filters)
	d.mu.Unlock()
	return d.DockerAPI.Containers(ctx, filters)
}

// rewriteResolv gives a running container of the fake node a new
// resolv.conf, as `docker restart` does.
func rewriteResolv(t *testing.T, env *Env, name, resolv string) {
	t.Helper()
	info, err := env.Docker.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	list, _ := env.Docker.Containers(context.Background(), nil)
	for _, c := range list {
		if c.Name() == name {
			if err := os.WriteFile(filepath.Join(info.DockerRootDir, "containers", c.ID, "resolv.conf"), []byte(resolv), 0o644); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatalf("no container %s", name)
}

// The build service asks this before a build: the check's own reading of
// the worker's resolv.conf and of a test container decides whether a
// restart helps. The test container runs only for a worker without a
// server.
func TestWorkerDNS(t *testing.T) {
	builder := build.BuilderPrefix + "-p1-2c-4g"
	other := build.BuilderPrefix + "-p2-2c-4g"
	worker, otherWorker := build.WorkerContainer(builder), build.WorkerContainer(other)
	good := overrideResolvConf("8.8.8.8", "1.1.1.1")
	images := "alpine:3.20\nmoby/buildkit:buildx-stable-1\n"
	for _, tc := range []struct {
		name    string
		node    dnsNode
		workers map[string]string
		want    build.WorkerDNSState
		probes  bool
	}{
		{name: "il-ra: a stale worker, Docker gives servers again", node: dnsNode{images: images, resolv: good},
			workers: map[string]string{worker: realNodeResolvConf}, want: build.WorkerDNSStale, probes: true},
		{name: "a stale worker on Docker that still gives none", node: dnsNode{images: images, resolv: realNodeResolvConf},
			workers: map[string]string{worker: realNodeResolvConf}, want: build.WorkerDNSNoServers, probes: true},
		{name: "a stale worker, Docker refuses the test container", node: dnsNode{images: images, runErr: errBadNameserver},
			workers: map[string]string{worker: realNodeResolvConf}, want: build.WorkerDNSNoServers, probes: true},
		{name: "a stale worker, no image for a test container", node: dnsNode{images: "node:22\n"},
			workers: map[string]string{worker: realNodeResolvConf}, want: build.WorkerDNSOK},
		{name: "a worker with servers", node: dnsNode{images: images, resolv: good},
			workers: map[string]string{worker: good, otherWorker: realNodeResolvConf}, want: build.WorkerDNSOK},
		{name: "no worker running", node: dnsNode{images: images, resolv: good},
			workers: map[string]string{otherWorker: realNodeResolvConf}, want: build.WorkerDNSOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, node, _ := dnsEnv(t, dnsCase{node: tc.node, workers: tc.workers, live: ptr(true)})
			fd := &filterDocker{DockerAPI: env.Docker}
			env.Docker = fd
			w := NewWorkerDNS(*env)
			if got := w.Worker(context.Background(), builder); got != tc.want {
				t.Fatalf("Worker = %v, want %v", got, tc.want)
			}
			ran := slices.ContainsFunc(node.cmds, func(c string) bool { return strings.Contains(c, " docker run ") })
			if ran != tc.probes {
				t.Fatalf("test container ran %v, want %v: %q", ran, tc.probes, node.cmds)
			}
			if !slices.ContainsFunc(fd.filters, func(f map[string][]string) bool {
				return slices.Equal(f["name"], []string{"^/" + regexp.QuoteMeta(worker) + "$"}) && slices.Equal(f["status"], []string{"running"})
			}) {
				t.Fatalf("the worker was not listed by its name: %v", fd.filters)
			}
		})
	}
}

// errBadNameserver is how Docker 28 refuses a container over a "dns"
// entry that is not an address.
var errBadNameserver = commandErr("docker: Error response from daemon: bad nameserver address <nil>")

type commandErr string

func (e commandErr) Error() string { return "env docker run: exit status 125: " + string(e) }

// In the agent's run the check restarts a stale build worker (through the
// build service, which skips one a build runs on) when the test container
// gets servers, and says it did; the next check passes as before.
func TestContainerDNSRestartsStaleWorkers(t *testing.T) {
	const (
		pass = agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS
		fl   = agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL
	)
	builder := build.BuilderPrefix + "-p1-2c-4g"
	worker := build.WorkerContainer(builder)
	good := overrideResolvConf("8.8.8.8", "1.1.1.1")
	const (
		valid   = `{"dns": ["8.8.8.8", "1.1.1.1"], "live-restore": true}`
		dockerd = "/usr/bin/dockerd -H fd://"
		images  = "alpine:3.20\nmoby/buildkit:buildx-stable-1\n"
	)
	heals := "The agent restarts a build worker like this by itself once Docker gives new containers servers they can use and no build runs on it: before the next build there, and at the next check."
	restartedNote := "; restarted the build worker " + worker + ", which had no DNS server it could use, from before: it now has the servers new containers get, and keeps its build cache"
	for _, tc := range []struct {
		name string
		dnsCase
		// busy: the build service restarts nothing (a build runs on it).
		busy       bool
		wantCalled bool
		want       agentv1.NodeCheckStatus
		detail     []string
		notDetails []string
		hint       []string
	}{
		{
			// The node's real case: Docker 29.1.3, Docker restarted since the
			// reload, the worker created in between.
			name:       "il-ra",
			dnsCase:    dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: images, resolv: good}, workers: map[string]string{worker: realNodeResolvConf}, live: ptr(true), version: "29.1.3"},
			wantCalled: true,
			want:       pass,
			detail: []string{`gets 8.8.8.8, 1.1.1.1, from "dns": [8.8.8.8, 1.1.1.1] in `, "/etc/docker/daemon.json" + restartedNote +
				`; Docker 29.1.3 loses its "dns" setting when it is reloaded (systemctl reload docker, or a SIGHUP; moby#52060, fixed in Docker 29.3.0), so restart Docker instead of reloading it`},
			notDetails: []string{"still has no DNS server"},
		},
		{
			name:       "Docker 29.5, a stale worker",
			dnsCase:    dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: images, resolv: good}, workers: map[string]string{worker: realNodeResolvConf}, live: ptr(true)},
			wantCalled: true,
			want:       pass,
			detail:     []string{restartedNote},
			notDetails: []string{"moby#52060", "reload"},
		},
		{
			name:       "a build runs on it",
			dnsCase:    dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: images, resolv: good}, workers: map[string]string{worker: realNodeResolvConf}, live: ptr(true)},
			busy:       true,
			wantCalled: true,
			want:       fl,
			detail:     []string{"but the build worker " + worker + " still has no DNS server it can use, from before"},
			notDetails: []string{"restarted the build worker"},
			hint:       []string{"`docker restart " + worker + "`", heals},
		},
		{
			// The reload bug still active: new containers get "invalid IP"
			// too, so a restart would give the worker the same.
			name:    "Docker hands out no servers",
			dnsCase: dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: images, resolv: realNodeResolvConf}, workers: map[string]string{worker: realNodeResolvConf}, live: ptr(true), version: "29.1.3"},
			want:    fl,
			detail: []string{`containers get no DNS server they can use`, `Docker 29.1.3 loses its "dns" setting when it is reloaded`,
				"the build worker " + worker + " still has no DNS server it can use"},
			notDetails: []string{"restarted the build worker"},
			hint:       []string{"Restart Docker, do not reload it", "`docker restart " + worker + "`", heals},
		},
		{
			name:    "no test container ran",
			dnsCase: dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: "node:22\n"}, workers: map[string]string{worker: realNodeResolvConf}, live: ptr(true)},
			want:    fl,
			detail:  []string{"the build worker " + worker + " still has no DNS server it can use"},
			hint:    []string{heals},
		},
		{
			name:    "a worker with servers",
			dnsCase: dnsCase{daemonJSON: valid, dockerd: dockerd, node: dnsNode{images: images, resolv: good}, workers: map[string]string{worker: good}, live: ptr(true)},
			want:    pass,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env, _, _ := dnsEnv(t, tc.dnsCase)
			var called [][]string
			env.RestartWorkers = func(_ context.Context, builders []string) []string {
				called = append(called, builders)
				if tc.busy {
					return nil
				}
				rewriteResolv(t, env, worker, good)
				return builders
			}
			r := Run(context.Background(), []Check{check{"docker.dns", containerDNSTitle, env.containerDNS}})[0]
			t.Logf("%v\n  detail: %s\n  hint: %s", r.GetStatus(), r.GetDetail(), r.GetFixHint())
			if (len(called) > 0) != tc.wantCalled || (tc.wantCalled && !slices.Equal(called[0], []string{builder})) {
				t.Fatalf("RestartWorkers calls %v, want called %v", called, tc.wantCalled)
			}
			if r.GetStatus() != tc.want {
				t.Fatalf("status = %v, want %v", r.GetStatus(), tc.want)
			}
			for _, want := range tc.detail {
				if !strings.Contains(r.GetDetail(), want) {
					t.Errorf("detail lacks %q", want)
				}
			}
			for _, not := range tc.notDetails {
				if strings.Contains(r.GetDetail(), not) {
					t.Errorf("detail has %q", not)
				}
			}
			for _, want := range tc.hint {
				if !strings.Contains(r.GetFixHint(), want) {
					t.Errorf("hint lacks %q", want)
				}
			}
			if tc.want == pass && strings.Contains(r.GetDetail(), "restarted") {
				// The next check reads the restarted worker and passes as
				// before, with nothing to restart.
				called = nil
				r = Run(context.Background(), []Check{check{"docker.dns", containerDNSTitle, env.containerDNS}})[0]
				if r.GetStatus() != pass || strings.Contains(r.GetDetail(), "restarted") || len(called) != 0 {
					t.Fatalf("next check: %v %q, restarts %v", r.GetStatus(), r.GetDetail(), called)
				}
			}
		})
	}
}
