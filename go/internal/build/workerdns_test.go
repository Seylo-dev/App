package build

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// fakeWorkerDNS plays the Container DNS code (nodecheck.WorkerDNS) on a
// node like il-ra: a stale worker has no DNS server it can use until it is
// restarted (`buildx stop` then a bootstrap), while new containers get
// servers, unless Docker hands out none (noServers) or a restart does not
// help (keepsStale).
type fakeWorkerDNS struct {
	mu         sync.Mutex
	stale      map[string]bool
	noServers  bool
	keepsStale bool
	calls      int
}

func (f *fakeWorkerDNS) Worker(_ context.Context, builder string) WorkerDNSState {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	switch {
	case !f.stale[builder]:
		return WorkerDNSOK
	case f.noServers:
		return WorkerDNSNoServers
	}
	return WorkerDNSStale
}

func (f *fakeWorkerDNS) restart(builder string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.noServers && !f.keepsStale {
		delete(f.stale, builder)
	}
}

func (f *fakeWorkerDNS) setStale(builder string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stale[builder] = true
}

func newDNSTestService(t *testing.T, fr *fakeRunner, rep *reports, dns *fakeWorkerDNS) *Service {
	t.Helper()
	fr.restarted = dns.restart
	dir := t.TempDir()
	svc := New(Options{
		Dir: filepath.Join(dir, "builds"), ToolsDir: filepath.Join(dir, "tools"),
		Runner: fr, Emit: rep.emit, Report: rep.report,
		Sizing:    &Sizing{Cores: 2, MemoryGB: 4},
		WorkerDNS: dns,
	})
	t.Cleanup(svc.Close)
	return svc
}

// svc1Builder is the builder inlineRequest's builds use (no project: the
// service's).
var svc1Builder = (Sizing{Cores: 2, MemoryGB: 4}).BuilderName("svc1")

func count(cmds []string, prefix string) int {
	n := 0
	for _, c := range cmds {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

// il-ra: the project's worker was created while Docker's "dns" setting was
// empty after a reload (moby#52060). Docker gives new containers servers
// again, but the agent kept using that worker until someone restarted it
// by hand. Now the next build restarts it first, once, says so in its log
// and builds; the cache stays (a stop and a bootstrap of the same builder,
// never a buildx rm).
func TestStaleWorkerRestartedOnceBeforeTheBuild(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder}}
	dns := &fakeWorkerDNS{stale: map[string]bool{svc1Builder: true}}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)

	p, log := buildLog(t, svc, rep, inlineRequest("b1"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("result = %v %q", p.GetStage(), p.GetMessage())
	}
	if strings.Count(log, dnsRestartedLine+"\n") != 1 {
		t.Fatalf("log lacks the restart line once:\n%s", log)
	}
	cmds := fr.commands()
	stop := slices.Index(cmds, "docker buildx stop "+svc1Builder)
	boot := slices.Index(cmds, "docker buildx inspect --bootstrap "+svc1Builder)
	build := slices.IndexFunc(cmds, func(c string) bool { return strings.HasPrefix(c, "docker buildx build ") })
	if stop < 0 || boot < stop || build < boot {
		t.Fatalf("want a stop, a bootstrap, then the build:\n%s", strings.Join(cmds, "\n"))
	}
	for _, c := range cmds {
		if strings.HasPrefix(c, "docker buildx rm") || strings.HasPrefix(c, "docker buildx create") || strings.HasPrefix(c, "docker rm") {
			t.Fatalf("the worker's cache must stay: %q", c)
		}
	}

	// Fixed: the next build uses it as it is.
	p, log = buildLog(t, svc, rep, inlineRequest("b2"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED || strings.Contains(log, "DNS server") {
		t.Fatalf("second build %v:\n%s", p.GetStage(), log)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 1 {
		t.Fatalf("%d restarts, want 1", n)
	}

	// A restart that helped holds nothing back: a worker that goes stale
	// again later is restarted again.
	dns.setStale(svc1Builder)
	if _, log = buildLog(t, svc, rep, inlineRequest("b3")); strings.Count(log, dnsRestartedLine+"\n") != 1 {
		t.Fatalf("third build:\n%s", log)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 2 {
		t.Fatalf("%d restarts, want 2", n)
	}
}

// A restart that does not help is not repeated build after build.
func TestStaleWorkerRestartNeverLoops(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder}}
	dns := &fakeWorkerDNS{stale: map[string]bool{svc1Builder: true}, keepsStale: true}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)
	_, log := buildLog(t, svc, rep, inlineRequest("b1"))
	if !strings.Contains(log, dnsNotHelpedLine+"\n") || strings.Contains(log, dnsRestartedLine) {
		t.Fatalf("log:\n%s", log)
	}
	for _, id := range []string{"b2", "b3"} {
		if _, log := buildLog(t, svc, rep, inlineRequest(id)); strings.Contains(log, "DNS server") {
			t.Fatalf("build %s:\n%s", id, log)
		}
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 1 {
		t.Fatalf("%d restarts, want 1", n)
	}
	if got := svc.RestartStaleWorkers(context.Background(), []string{svc1Builder}); len(got) != 0 {
		t.Fatalf("the check restarted %v again", got)
	}
}

// A restart cut short by its caller's context (the build's own cancel, a
// newer push in its place, or the Container DNS check ending) says nothing
// about the restart: it is not held back for dnsRestartPause, and the
// cancelled build's log has no "restarting it failed" line. The next build
// restarts the worker.
func TestStaleWorkerRestartCutShortIsTriedAgain(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder}}
	dns := &fakeWorkerDNS{stale: map[string]bool{svc1Builder: true}}
	var mu sync.Mutex
	var cut func()
	// cutNext: the next stop calls end, then fails the way a killed docker
	// does, and the worker keeps running stale.
	cutNext := func(end func()) {
		mu.Lock()
		defer mu.Unlock()
		cut = end
	}
	fr.stop = func(ctx context.Context, _ string) error {
		mu.Lock()
		end := cut
		cut = nil
		mu.Unlock()
		if end == nil {
			return nil
		}
		end()
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Second):
		}
		return errors.New("signal: killed")
	}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)

	cutNext(func() { _ = svc.Cancel("b1") })
	p, log := buildLog(t, svc, rep, inlineRequest("b1"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_CANCELLED || strings.Contains(log, "restarting it failed") {
		t.Fatalf("b1 = %v %q:\n%s", p.GetStage(), p.GetMessage(), log)
	}
	if n := count(fr.commands(), "docker buildx build"); n != 0 {
		t.Fatalf("the cancelled build ran %d builds", n)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cutNext(cancel)
	if got := svc.RestartStaleWorkers(ctx, []string{svc1Builder}); len(got) != 0 {
		t.Fatalf("the check that ended restarted %v", got)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 2 {
		t.Fatalf("%d stops, want 2: the check held back by b1's cut restart", n)
	}

	p, log = buildLog(t, svc, rep, inlineRequest("b2"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED || strings.Count(log, dnsRestartedLine+"\n") != 1 {
		t.Fatalf("b2 = %v %q:\n%s", p.GetStage(), p.GetMessage(), log)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 3 {
		t.Fatalf("%d stops, want 3", n)
	}
}

// A worker with servers it can use is judged and left alone.
func TestHealthyWorkerUntouched(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder}}
	dns := &fakeWorkerDNS{stale: map[string]bool{}}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)
	p, log := buildLog(t, svc, rep, inlineRequest("b1"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED || strings.Contains(log, "DNS server") {
		t.Fatalf("result %v:\n%s", p.GetStage(), log)
	}
	if dns.calls == 0 {
		t.Fatal("the worker was not judged")
	}
	cmds := fr.commands()
	if count(cmds, "docker buildx stop") != 0 || count(cmds, "docker buildx inspect --bootstrap") != 0 {
		t.Fatalf("restarted a healthy worker:\n%s", strings.Join(cmds, "\n"))
	}
	if got := svc.RestartStaleWorkers(context.Background(), []string{svc1Builder}); len(got) != 0 {
		t.Fatalf("the check restarted %v", got)
	}
}

// A worker a build runs on is never restarted, neither by the next build
// of the project nor by the check; once the builds end the check restarts
// it.
func TestBusyWorkerNotRestarted(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder}}
	dns := &fakeWorkerDNS{stale: map[string]bool{}}
	running, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	fr.build = func(ctx context.Context, c Cmd) error {
		first := false
		once.Do(func() { first = true })
		if first {
			close(running)
			<-release
		}
		fmt.Fprintln(c.Stdout, "#1 building")
		return nil
	}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)
	svc.SetParallel(2)
	if _, err := svc.Start(inlineRequest("b1")); err != nil {
		t.Fatal(err)
	}
	<-running
	// The worker loses its servers while b1 runs on it.
	dns.setStale(svc1Builder)
	if got := svc.RestartStaleWorkers(context.Background(), []string{svc1Builder}); len(got) != 0 {
		t.Fatalf("the check restarted %v under a build", got)
	}
	second, err := svc.Start(inlineRequest("b2"))
	if err != nil {
		t.Fatal(err)
	}
	if p := finalOf(t, rep); p.GetBuildId() != "b2" || p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("b2 = %v", p)
	}
	var log strings.Builder
	_ = second.Watch(context.Background(), func(r *agentv1.BuildResponse) error { log.Write(r.GetLog()); return nil })
	if strings.Contains(log.String(), "DNS server") {
		t.Fatalf("b2 restarted the worker b1 runs on:\n%s", log.String())
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 0 {
		t.Fatalf("%d restarts while b1 runs", n)
	}
	close(release)
	if p := finalOf(t, rep); p.GetBuildId() != "b1" || p.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("b1 = %v", p)
	}
	if got := svc.RestartStaleWorkers(context.Background(), []string{svc1Builder}); !slices.Equal(got, []string{svc1Builder}) {
		t.Fatalf("the check restarted %v once the builds ended", got)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 1 {
		t.Fatalf("%d restarts, want 1", n)
	}
}

// While Docker itself gives new containers no DNS server (the reload bug
// still active), a restart would not help: nothing is restarted, and the
// failed lookup gets today's line pointing at the Container DNS check. A
// builder that is not ours is never touched.
func TestDockerWithoutServersRestartsNothing(t *testing.T) {
	fr := &fakeRunner{builders: []string{svc1Builder, "someone-elses"}}
	dns := &fakeWorkerDNS{stale: map[string]bool{svc1Builder: true, "someone-elses": true}, noServers: true}
	fr.build = func(_ context.Context, c Cmd) error {
		fmt.Fprintln(c.Stdout, "ERROR: failed to solve: busybox: failed to resolve source metadata for docker.io/library/busybox:latest: "+
			"failed to do request: Head \"https://registry-1.docker.io/v2/library/busybox/manifests/latest\": dial tcp: lookup registry-1.docker.io on [::1]:53: read udp [::1]:41858->[::1]:53: read: connection refused")
		return &ExitError{Cmd: "docker", Code: 1}
	}
	rep := newReports()
	svc := newDNSTestService(t, fr, rep, dns)
	p, log := buildLog(t, svc, rep, inlineRequest("b1"))
	if p.GetStage() != agentv1.BuildStage_BUILD_STAGE_FAILED {
		t.Fatalf("result = %v", p)
	}
	if !strings.HasSuffix(log, "the lines above say why\n--> "+DNSHint+"\n") || strings.Contains(log, "restart") {
		t.Fatalf("log:\n%s", log)
	}
	if got := svc.RestartStaleWorkers(context.Background(), []string{svc1Builder}); len(got) != 0 {
		t.Fatalf("the check restarted %v", got)
	}

	dns.mu.Lock()
	dns.noServers = false
	dns.mu.Unlock()
	if got := svc.RestartStaleWorkers(context.Background(), []string{"someone-elses"}); len(got) != 0 {
		t.Fatalf("restarted a builder that is not ours: %v", got)
	}
	if n := count(fr.commands(), "docker buildx stop"); n != 0 {
		t.Fatalf("%d restarts:\n%s", n, strings.Join(fr.commands(), "\n"))
	}
}
