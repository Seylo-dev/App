//go:build integration

package registry

// Docker tests for the Tunnel targets (scripts/dev/vm-gotest.sh
// ./internal/registry -v). Builds and pushes through the relay are covered
// in internal/build's integration tests.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

func itPrefix(t *testing.T) string {
	t.Helper()
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration tests run in the test VM (SEYLO_IT=1)")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	return "bdit-" + hex.EncodeToString(b[:])
}

func run(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// get sends one HTTP request through a Tunnel stream and returns the body.
func get(t *testing.T, node *rpctest.Peer, req *agentv1.TunnelRequest, path string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s, err := node.Open(ctx, "Tunnel", req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(s, "GET "+path+" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	_ = s.CloseSend()
	raw, err := io.ReadAll(s)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(&agentv1.TunnelResponse{}); err != nil {
		t.Fatal(err)
	}
	head, body, _ := strings.Cut(string(raw), "\r\n\r\n")
	if !strings.HasPrefix(head, "HTTP/1.") {
		t.Fatalf("response %q", raw)
	}
	return body
}

func TestTunnelToServicePort(t *testing.T) {
	prefix := itPrefix(t)
	svc := prefix + "-svc"
	net := prefix + "-net"
	run(t, "network", "create", "--label", "bdit="+prefix, net)
	t.Cleanup(func() { _ = exec.Command("docker", "network", "rm", net).Run() })
	for gen, text := range map[string]string{"1": "old generation", "2": "new generation"} {
		id := run(t, "run", "-d", "--network", net,
			"--label", docker.LabelManaged+"=true", "--label", docker.LabelService+"="+svc, "--label", docker.LabelGeneration+"="+gen,
			"--label", "bdit="+prefix,
			"busybox:1.37", "sh", "-c", "mkdir /www && echo '"+text+"' > /www/index.html && httpd -f -p 8080 -h /www")
		t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", id).Run() })
	}

	reg := rpc.NewAgentMux()
	tun := &Tunnel{Dial: &NodeDialer{Registry: &Server{}}}
	rpc.HandleRaw(reg, "Tunnel", tun.Serve)
	node := rpctest.NewPeer(t, reg)
	req := &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_ServicePort{ServicePort: &agentv1.ServicePortTarget{ServiceId: svc, Port: 8080}}}

	var body string
	for range 20 {
		body = func() string {
			defer func() { _ = recover() }()
			return get(t, node, req, "/")
		}()
		if body != "" {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if strings.TrimSpace(body) != "new generation" {
		t.Fatalf("tunnel reached %q, want the newest generation", body)
	}

	missing := &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_ServicePort{ServicePort: &agentv1.ServicePortTarget{ServiceId: prefix + "-none", Port: 80}}}
	s, err := node.Open(context.Background(), "Tunnel", missing)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.CloseSend()
	if st := rpc.StatusOf(s.Finish(nil)); st.GetCode() != agentv1.StatusCode_STATUS_CODE_NOT_FOUND {
		t.Fatalf("missing service: %v", st)
	}
}

func TestRegistryServerLifecycle(t *testing.T) {
	prefix := itPrefix(t)
	srv := &Server{Name: prefix + "-registry", Network: prefix + "-registry", DataDir: t.TempDir()}
	t.Cleanup(func() { srv.Remove(context.Background()) })

	reg := rpc.NewAgentMux()
	rpc.HandleRaw(reg, "Tunnel", (&Tunnel{Dial: &NodeDialer{Registry: srv}}).Serve)
	node := rpctest.NewPeer(t, reg)
	req := &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{}}}

	// First use starts the registry.
	if body := get(t, node, req, "/v2/_catalog"); !strings.Contains(body, "repositories") {
		t.Fatalf("catalog %q", body)
	}
	labels := run(t, "container", "inspect", "--format", `{{index .Config.Labels "`+docker.LabelManaged+`"}} {{index .Config.Labels "`+docker.LabelRole+`"}} {{.HostConfig.CgroupParent}} {{len .NetworkSettings.Ports}}`, srv.Name)
	if labels != "true registry "+docker.CgroupParent+" 1" {
		t.Fatalf("container labels/cgroup/ports: %q", labels)
	}
	if published := run(t, "container", "port", srv.Name); published != "" {
		t.Fatalf("the registry is published: %q", published)
	}

	// Stopped (node reboot): the next tunnel starts it again.
	run(t, "container", "stop", srv.Name)
	if body := get(t, node, req, "/v2/"); strings.TrimSpace(body) != "{}" {
		t.Fatalf("after restart: %q", body)
	}

	// Garbage collection with no open tunnel stops, collects, restarts.
	if err := srv.CollectGarbage(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state := run(t, "container", "inspect", "--format", "{{.State.Running}}", srv.Name); state != "true" {
		t.Fatalf("registry running after GC: %s", state)
	}
	if body := get(t, node, req, "/v2/"); strings.TrimSpace(body) != "{}" {
		t.Fatalf("after GC: %q", body)
	}
}

// TestScopedRelayWithDocker pushes and pulls with the real Docker and the
// real registry through relays the way the panel scopes them: the build
// node may push its service, another node may pull only its own, and
// neither may delete or list.
func TestScopedRelayWithDocker(t *testing.T) {
	prefix := itPrefix(t)
	srv := &Server{Name: prefix + "-registry", Network: prefix + "-registry", DataDir: t.TempDir()}
	t.Cleanup(func() { srv.Remove(context.Background()) })
	reg := rpc.NewAgentMux()
	rpc.HandleRaw(reg, "Tunnel", (&Tunnel{Dial: &NodeDialer{Registry: srv}}).Serve)
	node := rpctest.NewPeer(t, reg)

	own, other := prefix+"own", prefix+"other"
	builder := startRelay(t, &scopedBridge{node: node, scope: &agentv1.RegistryScope{NodeId: "a", Push: []string{own}}})
	puller := startRelay(t, &scopedBridge{node: node, scope: &agentv1.RegistryScope{NodeId: "b", Pull: []string{own}}})
	full := startRelay(t, &panelBridge{node: node}) // the panel itself (no scope)
	var tags []string
	t.Cleanup(func() {
		for _, tag := range tags {
			_ = exec.Command("docker", "image", "rm", "-f", tag).Run()
		}
	})
	tag := func(ref string) string {
		run(t, "tag", "busybox:1.37", ref)
		tags = append(tags, ref)
		return ref
	}
	// refused runs a docker command that the scope must refuse (403:
	// "denied" with a body, "403 Forbidden" for a HEAD).
	refused := func(args ...string) bool {
		t.Helper()
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err == nil {
			t.Fatalf("docker %s worked, want refused:\n%s", strings.Join(args, " "), out)
		}
		ok := strings.Contains(string(out), "denied") || strings.Contains(string(out), "403") || strings.Contains(string(out), "may not")
		if !ok {
			t.Logf("docker %s:\n%s", strings.Join(args, " "), out)
		}
		return ok
	}
	run(t, "pull", "busybox:1.37")

	run(t, "push", tag(builder+"/"+own+":1"))
	run(t, "push", tag(full+"/"+other+":1"))
	if !refused("push", tag(builder+"/"+other+":2")) {
		t.Fatal("push outside the scope failed for another reason")
	}
	pulled := puller + "/" + own + ":1"
	tags = append(tags, pulled, puller+"/"+other+":1")
	run(t, "pull", pulled)
	if !refused("pull", puller+"/"+other+":1") {
		t.Fatal("pull outside the scope failed for another reason")
	}
	if !refused("push", tag(puller+"/"+own+":3")) {
		t.Fatal("push from a pull-only node failed for another reason")
	}

	digest := strings.TrimPrefix(run(t, "image", "inspect", "--format", "{{index .RepoDigests 0}}", pulled), puller+"/"+own+"@")
	for _, c := range []struct{ method, path string }{
		{"DELETE", "/v2/" + own + "/manifests/" + digest},
		{"GET", "/v2/_catalog"},
	} {
		req, _ := http.NewRequest(c.method, "http://"+builder+c.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s through a node relay: %d", c.method, c.path, resp.StatusCode)
		}
	}
	// A build node that pushed another service's layers earlier: Docker
	// asks to mount them from that repository, the gate strips the mount
	// (not in the scope any more) and Docker uploads them instead.
	sb := &scopedBridge{node: node, scope: &agentv1.RegistryScope{NodeId: "c", Push: []string{prefix + "first"}}}
	shared := startRelay(t, sb)
	run(t, "push", tag(shared+"/"+prefix+"first:1"))
	sb.setScope(&agentv1.RegistryScope{NodeId: "c", Push: []string{prefix + "second"}})
	if out := run(t, "push", tag(shared+"/"+prefix+"second:1")); strings.Contains(out, "Mounted from") {
		t.Fatalf("a layer was mounted from a repository outside the scope:\n%s", out)
	}

	// The panel's own GC (no scope) still deletes.
	req, _ := http.NewRequest("DELETE", "http://"+full+"/v2/"+own+"/manifests/"+digest, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("GC delete: %d", resp.StatusCode)
	}
}

func (p *scopedBridge) setScope(s *agentv1.RegistryScope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.scope = s
}
