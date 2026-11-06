//go:build integration

package build_test

// Real builds against Docker in the test VM (scripts/dev/vm-gotest.sh
// ./internal/build -v). Every resource gets a per-run prefix and is removed
// at the end. The chain under test is the production one minus the panel:
// docker push -> relay on 127.0.0.1:<high port> -> RegistryTunnel ->
// AgentService.Tunnel(RegistryTarget) -> registry container.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc"
)

type env struct {
	prefix   string
	push     string // 127.0.0.1:<port>
	svc      *build.Service
	reports  chan *agentv1.BuildProgress
	server   *registry.Server
	builtDir string
	repos    []string
}

// repo names an image repository of this run, removed at cleanup.
func (e *env) repo(name string) string {
	r := e.push + "/" + e.prefix + "-" + name
	e.repos = append(e.repos, r)
	return r
}

// sessions connects a node agent (serving Tunnel) and a Go stand-in for
// the panel (serving RegistryTunnel like apps/panel's registryTunnel) with
// real rpc sessions over an in-memory transport. The node is the panel's
// node here, so the panel opens Tunnel back on the same connection.
func sessions(ctx context.Context, t *testing.T, tunnel *registry.Tunnel) *rpc.Session {
	t.Helper()
	agentEnd, panelEnd := conn.Pipe()
	agentMux := rpc.NewAgentMux()
	rpc.HandleRaw(agentMux, "Tunnel", tunnel.Serve)

	var panel *rpc.Session
	var openMu sync.Mutex // stream ids must reach the peer in order
	panelMux := rpc.NewPanelMux()
	rpc.HandleRaw(panelMux, "RegistryTunnel", func(ctx context.Context, _ *agentv1.RegistryTunnelRequest, s rpc.RawStream) (*agentv1.RegistryTunnelResponse, error) {
		openMu.Lock()
		up, err := panel.Open(ctx, "Tunnel", &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{}}})
		openMu.Unlock()
		if err != nil {
			return nil, err
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = io.Copy(up, s)
			_ = up.CloseSend()
		}()
		_, err = io.Copy(s, up)
		<-done
		if ferr := up.Finish(&agentv1.TunnelResponse{}); err == nil {
			err = ferr
		}
		return &agentv1.RegistryTunnelResponse{}, err
	})
	agent := rpc.NewSession(rpc.SessionConfig{Transport: agentEnd, Role: conn.RoleDialer, Handlers: agentMux, PeerCapabilities: panelMux.Capabilities()})
	panel = rpc.NewSession(rpc.SessionConfig{Transport: panelEnd, Role: conn.RoleAcceptor, Handlers: panelMux, PeerCapabilities: agentMux.Capabilities()})
	go func() { _ = agent.Serve(ctx) }()
	go func() { _ = panel.Serve(ctx) }()
	t.Cleanup(func() {
		if err := agent.Err(); err != nil && ctx.Err() == nil {
			t.Errorf("agent session ended: %v", err)
		}
		_ = agent.Close(nil)
		_ = panel.Close(nil)
	})
	return agent
}

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func freePort(t *testing.T) int {
	t.Helper()
	for range 20 {
		var b [2]byte
		_, _ = rand.Read(b[:])
		p := 20000 + int(b[0])<<8%40000 + int(b[1])
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			l.Close()
			return p
		}
	}
	t.Fatal("no free port")
	return 0
}

func setup(t *testing.T) *env {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration tests run in the test VM (SEYLO_IT=1)")
	}
	var rb [3]byte
	_, _ = rand.Read(rb[:])
	prefix := "bdit-" + hex.EncodeToString(rb[:])
	e := &env{prefix: prefix, reports: make(chan *agentv1.BuildProgress, 8)}
	ctx, cancel := context.WithCancel(context.Background())

	// The registry container, on its own network, storage in a temp dir.
	e.server = &registry.Server{Name: prefix + "-registry", Network: prefix + "-registry", DataDir: t.TempDir()}
	agent := sessions(ctx, t, &registry.Tunnel{Dial: &registry.NodeDialer{Registry: e.server}})

	// The relay every node runs, on a high port.
	port := freePort(t)
	ready := make(chan string, 1)
	relay := &registry.TCPRelay{Addr: fmt.Sprintf("127.0.0.1:%d", port), Ready: func(a string) { ready <- a }}
	relayDone := make(chan error, 1)
	go func() { relayDone <- relay.Run(ctx, agent) }()
	e.push = <-ready

	// Tools are cached across runs to keep the VM's downloads small.
	tools := filepath.Join(os.TempDir(), "bdit-tools")
	build.BuilderPrefix = prefix + "-builder"
	e.builtDir = t.TempDir()
	e.svc = build.New(build.Options{
		Dir: e.builtDir, ToolsDir: tools, Registry: e.push, Parallel: 2,
		Sizing: &build.Sizing{Cores: 2, MemoryGB: 3},
		Report: func(_ context.Context, ev *agentv1.Event) error { e.reports <- ev.GetBuildProgress(); return nil },
	})

	t.Cleanup(func() {
		e.svc.Close()
		cancel()
		<-relayDone
		cctx := context.Background()
		e.server.Remove(cctx)
		// Our builders (one per project) and every image of this run.
		ls := exec.Command("docker", "buildx", "ls", "--format", "{{.Name}}")
		ls.Env = append(os.Environ(), "DOCKER_CONFIG="+filepath.Join(e.builtDir, "docker"))
		names, _ := ls.Output()
		for _, name := range strings.Fields(string(names)) {
			name = strings.TrimSuffix(name, "*")
			if !strings.HasPrefix(name, build.BuilderPrefix+"-") {
				continue
			}
			rm := exec.Command("docker", "buildx", "rm", "--force", name)
			rm.Env = ls.Env
			_ = rm.Run()
		}
		for _, repo := range e.repos {
			out, _ := exec.Command("docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo).Output()
			for _, ref := range strings.Fields(string(out)) {
				_ = exec.Command("docker", "image", "rm", "-f", ref).Run()
			}
			out, _ = exec.Command("docker", "image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}", repo).Output()
			for _, ref := range strings.Fields(string(out)) {
				_ = exec.Command("docker", "image", "rm", "-f", ref).Run()
			}
		}
		_ = exec.Command("docker", "container", "prune", "-f", "--filter", "label=bdit="+prefix).Run()
	})
	return e
}

func tarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = zw.Close()
	return buf.Bytes()
}

func (e *env) upload(t *testing.T, id string, files map[string]string) {
	t.Helper()
	archive := tarGz(t, files)
	sum := sha256.Sum256(archive)
	req := &agentv1.UploadBuildContextRequest{UploadId: id, SizeBytes: uint64(len(archive)), Sha256: hex.EncodeToString(sum[:])}
	if err := e.svc.StoreContext(context.Background(), req, bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
}

// run builds req and returns the pushed digest, failing with the log.
func (e *env) run(t *testing.T, req *agentv1.BuildRequest, timeout time.Duration) string {
	t.Helper()
	job, err := e.svc.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	var log strings.Builder
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	werr := job.Watch(ctx, func(r *agentv1.BuildResponse) error {
		log.Write(r.GetLog())
		return nil
	})
	final := job.Final()
	if werr != nil || final.GetStage() != agentv1.BuildStage_BUILD_STAGE_SUCCEEDED {
		t.Fatalf("build %s: %v %v\n%s", req.GetBuildId(), werr, final, tail(log.String(), 80))
	}
	select {
	case p := <-e.reports:
		if p.GetImageDigest() != final.GetImageDigest() {
			t.Fatalf("durable report %v, final %v", p, final)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no durable report")
	}
	t.Logf("%s built in %s: %s", req.GetBuildId(), final.GetDuration().AsDuration(), final.GetImageDigest())
	return final.GetImageDigest()
}

func tail(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// pullByDigest drops every local copy of repo and pulls repo@digest
// through the relay, as another node would.
func (e *env) pullByDigest(t *testing.T, repo, digest string) string {
	t.Helper()
	tags, _ := exec.Command("docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo).Output()
	digests, _ := exec.Command("docker", "image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}", repo).Output()
	for _, ref := range strings.Fields(string(tags) + " " + string(digests)) {
		if !strings.Contains(ref, "<none>") {
			_ = exec.Command("docker", "image", "rm", ref).Run()
		}
	}
	if left, _ := exec.Command("docker", "image", "ls", "-q", repo).Output(); len(bytes.TrimSpace(left)) > 0 {
		t.Fatalf("local copies of %s left: %s", repo, left)
	}
	ref := repo + "@" + digest
	docker(t, "pull", "-q", ref)
	return ref
}

func TestDockerfileBuildPushPull(t *testing.T) {
	e := setup(t)
	e.upload(t, "dockerfile-ctx", map[string]string{
		"app/Dockerfile": "FROM busybox:1.37 AS base\nARG GREETING\nRUN --mount=type=secret,id=TOKEN test \"$(wc -c < /run/secrets/TOKEN)\" -eq 6\nRUN echo \"$GREETING from the dockerfile\" > /msg\nFROM base AS final\nCMD [\"cat\", \"/msg\"]\nFROM base AS other\nCMD [\"echo\", \"wrong stage\"]\n",
		"app/README":     "context file\n",
	})
	repo := e.repo("df")
	digest := e.run(t, &agentv1.BuildRequest{
		BuildId: "df1", ServiceId: e.prefix + "-df", ImageReference: repo + ":1",
		Source:      &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "dockerfile-ctx"}},
		Builder:     agentv1.Builder_BUILDER_DOCKERFILE,
		ContextPath: "app", TargetStage: "final",
		Env: []*agentv1.EnvVar{{Name: "GREETING", Value: "hello"}, {Name: "TOKEN", Value: "s3cret", Secret: true}},
	}, 10*time.Minute)

	ref := e.pullByDigest(t, repo, digest)
	if out := docker(t, "run", "--rm", "--label", "bdit="+e.prefix, ref); out != "hello from the dockerfile" {
		t.Fatalf("container said %q", out)
	}
	if hist := docker(t, "image", "history", "--no-trunc", ref); strings.Contains(hist, "s3cret") {
		t.Fatal("the secret is in the image history")
	}

	// Garbage collection keeps referenced blobs: the image still pulls.
	// The builder's cache: reported, then emptied (cleanup.CachePruner).
	n, items, err := e.svc.PruneCache(context.Background(), true)
	if err != nil || n == 0 || len(items) != 1 {
		t.Fatalf("cache dry run: %d %v %v", n, items, err)
	}
	if _, items, err = e.svc.PruneCache(context.Background(), false); err != nil || len(items) != 1 {
		t.Fatalf("cache prune: %v %v", items, err)
	}
	if n, _, _ := e.svc.PruneCache(context.Background(), true); n != 0 {
		t.Fatalf("%d bytes reclaimable after the prune", n)
	}

	// Docker keeps idle connections to the relay for a while; collection
	// waits until none is open.
	deadline := time.Now().Add(4 * time.Minute)
	for {
		err := e.server.CollectGarbage(context.Background())
		if err == nil {
			break
		}
		if !errors.Is(err, registry.ErrBusy) || time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Second)
	}
	e.pullByDigest(t, repo, digest)
}

// A cache mount filled by one project's build is empty in another
// project's build: every project has its own BuildKit builder.
func TestCacheMountsStayInTheirProject(t *testing.T) {
	e := setup(t)
	build := func(id, project, dockerfile string) string {
		t.Helper()
		e.upload(t, id+"-ctx", map[string]string{"Dockerfile": dockerfile})
		repo := e.repo(id)
		digest := e.run(t, &agentv1.BuildRequest{
			BuildId: id, ServiceId: e.prefix + "-" + id, ProjectId: project, ImageReference: repo + ":1",
			Source:  &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: id + "-ctx"}},
			Builder: agentv1.Builder_BUILDER_DOCKERFILE,
		}, 5*time.Minute)
		return docker(t, "run", "--rm", "--label", "bdit="+e.prefix, e.pullByDigest(t, repo, digest))
	}
	writer := "FROM busybox:1.37\nRUN --mount=type=cache,target=/root/.npm echo private-package > /root/.npm/tarball && echo written > /msg\nCMD [\"cat\", \"/msg\"]\n"
	reader := "FROM busybox:1.37\nRUN --mount=type=cache,target=/root/.npm (cat /root/.npm/tarball 2>/dev/null || echo empty) > /msg\nCMD [\"cat\", \"/msg\"]\n"
	if out := build("cachea", "projecta", writer); out != "written" {
		t.Fatalf("writer said %q", out)
	}
	if out := build("cacheb", "projectb", reader); out != "empty" {
		t.Fatalf("another project's build read %q from the cache mount", out)
	}
	// The same project does share its cache.
	if out := build("cachec", "projecta", reader); out != "private-package" {
		t.Fatalf("the same project's build read %q", out)
	}
}

func TestImageSourceMirror(t *testing.T) {
	e := setup(t)
	repo := e.repo("img")
	digest := e.run(t, &agentv1.BuildRequest{
		BuildId: "img1", ServiceId: e.prefix + "-img", ImageReference: repo + ":1",
		Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_Image{Image: &agentv1.ImageSource{Reference: "busybox:1.37"}}},
	}, 5*time.Minute)
	ref := e.pullByDigest(t, repo, digest)
	if out := docker(t, "run", "--rm", "--label", "bdit="+e.prefix, ref, "echo", "mirrored"); out != "mirrored" {
		t.Fatalf("container said %q", out)
	}
}

// serveAndGet runs ref, then fetches http://localhost:<port>/ from inside
// its network namespace.
func serveAndGet(t *testing.T, e *env, ref string, port int) string {
	t.Helper()
	id := docker(t, "run", "-d", "--label", "bdit="+e.prefix, "-e", fmt.Sprintf("PORT=%d", port), ref)
	defer exec.Command("docker", "rm", "-f", id).Run()
	var out []byte
	var err error
	for range 60 {
		out, err = exec.Command("docker", "run", "--rm", "--label", "bdit="+e.prefix, "--network", "container:"+id, "busybox:1.37",
			"wget", "-qO-", fmt.Sprintf("http://127.0.0.1:%d/", port)).Output()
		if err == nil {
			return strings.TrimSpace(string(out))
		}
		time.Sleep(time.Second)
	}
	logs, _ := exec.Command("docker", "logs", id).CombinedOutput()
	t.Fatalf("app never answered: %v\n%s", err, logs)
	return ""
}

func TestRailpackNode(t *testing.T) {
	e := setup(t)
	e.upload(t, "node-ctx", map[string]string{
		"package.json":      `{"name":"bdit-node","version":"1.0.0","private":true,"scripts":{"start":"node index.js"}}`,
		"package-lock.json": `{"name":"bdit-node","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"bdit-node","version":"1.0.0"}}}`,
		"index.js":          `require("http").createServer((q, s) => s.end("node says " + process.env.GREETING)).listen(process.env.PORT || 3000)`,
	})
	repo := e.repo("node")
	digest := e.run(t, &agentv1.BuildRequest{
		BuildId: "node1", ServiceId: e.prefix + "-node", ImageReference: repo + ":1",
		Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "node-ctx"}},
		Env:    []*agentv1.EnvVar{{Name: "GREETING", Value: "hi", Secret: true}},
	}, 20*time.Minute)
	ref := e.pullByDigest(t, repo, digest)
	// Build-time secrets are not baked into the image: the runtime env
	// supplies them, so here GREETING is unset.
	if got := serveAndGet(t, e, ref, 3000); got != "node says undefined" {
		t.Fatalf("node app said %q", got)
	}
}

func TestRailpackGo(t *testing.T) {
	e := setup(t)
	e.upload(t, "go-ctx", map[string]string{
		"go.mod":  "module example.com/bdit\n\ngo 1.24\n",
		"main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"net/http\"\n\t\"os\"\n)\n\nfunc main() {\n\thttp.HandleFunc(\"/\", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, \"go says hi\") })\n\tport := os.Getenv(\"PORT\")\n\tif port == \"\" {\n\t\tport = \"8080\"\n\t}\n\t_ = http.ListenAndServe(\":\"+port, nil)\n}\n",
	})
	repo := e.repo("go")
	digest := e.run(t, &agentv1.BuildRequest{
		BuildId: "go1", ServiceId: e.prefix + "-go", ImageReference: repo + ":1",
		Source: &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "go-ctx"}},
	}, 20*time.Minute)
	ref := e.pullByDigest(t, repo, digest)
	if got := serveAndGet(t, e, ref, 8080); got != "go says hi" {
		t.Fatalf("go app said %q", got)
	}
}

func TestNixpacksNode(t *testing.T) {
	if os.Getenv("SEYLO_IT_NIXPACKS") != "1" {
		t.Skip("set SEYLO_IT_NIXPACKS=1: pulls the large Nixpacks base image")
	}
	e := setup(t)
	e.upload(t, "nix-ctx", map[string]string{
		"package.json":      `{"name":"bdit-nix","version":"1.0.0","private":true,"scripts":{"start":"node index.js"}}`,
		"package-lock.json": `{"name":"bdit-nix","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"bdit-nix","version":"1.0.0"}}}`,
		"index.js":          `require("http").createServer((q, s) => s.end("nix says " + process.env.NODE_ENV)).listen(3000)`,
	})
	repo := e.repo("nix")
	digest := e.run(t, &agentv1.BuildRequest{
		BuildId: "nix1", ServiceId: e.prefix + "-nix", ImageReference: repo + ":1",
		Source:  &agentv1.BuildSource{Source: &agentv1.BuildSource_UploadId{UploadId: "nix-ctx"}},
		Builder: agentv1.Builder_BUILDER_NIXPACKS,
	}, 30*time.Minute)
	ref := e.pullByDigest(t, repo, digest)
	if got := serveAndGet(t, e, ref, 3000); got != "nix says production" {
		t.Fatalf("nixpacks app said %q", got)
	}
}
