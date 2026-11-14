package agent

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// config.yml's git_proxy_resolves reaches the node's git fetches: behind
// the agent's HTTP proxy, a git host the node cannot resolve is refused
// (the message names the key and this node's config.yml), and with the
// key it goes on to the proxy, as before 0.2.
func TestGitProxyResolvesFromConfig(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if err := os.WriteFile(path, []byte("panel_url: https://panel.test\nnode_id: node1\ngit_proxy_resolves: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.GitProxyResolves {
		t.Fatal("git_proxy_resolves was not read")
	}

	// The agent's HTTP proxy: records each CONNECT and refuses it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var mu sync.Mutex
	var seen []string
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, _ := bufio.NewReader(c).ReadString('\n')
				mu.Lock()
				seen = append(seen, strings.TrimSpace(line))
				mu.Unlock()
				_, _ = c.Write([]byte("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"))
			}()
		}
	}()
	t.Setenv("HTTPS_PROXY", "http://"+ln.Addr().String())
	t.Setenv("HTTP_PROXY", "")
	t.Setenv("NO_PROXY", "")
	for _, k := range []string{"https_proxy", "http_proxy", "no_proxy"} {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}

	fetch := func(resolves bool) error {
		d, _ := newTestDeps(t)
		d.Config.GitProxyResolves = resolves
		reg := rpc.NewAgentMux()
		if err := provideBuild(d); err != nil {
			t.Fatal(err)
		}
		if err := wireBuild(reg, d); err != nil {
			t.Fatal(err)
		}
		panel := rpctest.NewPeer(t, reg)
		var resp agentv1.FetchGitFileResponse
		return panel.Call(context.Background(), "FetchGitFile", &agentv1.FetchGitFileRequest{
			Source: &agentv1.GitSource{Url: "https://git.nowhere.invalid/team/app.git", Ref: "main"},
			Path:   "compose.yml",
		}, &resp)
	}

	err = fetch(false)
	var rpcErr *rpc.Error
	if !errors.As(err, &rpcErr) || !strings.Contains(err.Error(), "cannot resolve git.nowhere.invalid") ||
		!strings.Contains(err.Error(), "git_proxy_resolves: true in ") || !strings.Contains(err.Error(), "config.yml") {
		t.Fatalf("without the key: %v", err)
	}
	mu.Lock()
	before := slices.Clone(seen)
	mu.Unlock()
	if len(before) != 0 {
		t.Fatalf("went to the proxy without the key: %v", before)
	}

	if err := fetch(true); err == nil || strings.Contains(err.Error(), "cannot resolve") {
		t.Fatalf("with the key: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Contains(seen, "CONNECT git.nowhere.invalid:443 HTTP/1.1") {
		t.Fatalf("with the key the proxy saw %v", seen)
	}
}

// A fetch that fails on the node's network names the node as the panel
// does, also after a rename, and points at its Health check, not at the
// credentials (a refused connection, which a wrong port gives too: the
// address first).
func TestGitNetworkFailureNamesTheNode(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	for _, k := range []string{"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"} {
		t.Setenv(k, "")
		_ = os.Unsetenv(k)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := ln.Addr().String()
	_ = ln.Close()

	d, _ := newTestDeps(t)
	reg := rpc.NewAgentMux()
	if err := provideBuild(d); err != nil {
		t.Fatal(err)
	}
	if err := wireBuild(reg, d); err != nil {
		t.Fatal(err)
	}
	panel := rpctest.NewPeer(t, reg)
	fetch := func() error {
		var resp agentv1.FetchGitFileResponse
		return panel.Call(context.Background(), "FetchGitFile", &agentv1.FetchGitFileRequest{
			Source: &agentv1.GitSource{Url: "https://" + closed + "/team/app.git", Ref: "main", AllowInternalHost: true},
			Path:   "compose.yml",
		}, &resp)
	}
	for i, name := range []string{"", "de-fsn-1", "de-fsn-2"} {
		if name != "" {
			d.Feed.Publish(&agentv1.DesiredState{Revision: uint64(i), Settings: &agentv1.NodeSettings{NodeName: name}})
		}
		who := "this node"
		if name != "" {
			who = "node " + name
		}
		err := fetch()
		if err == nil || !strings.Contains(err.Error(), who+" could not connect to "+closed+" - check the address: dial tcp "+closed+": connect: connection refused") ||
			!strings.Contains(err.Error(), "If the address is right, the node's Health check") || strings.Contains(err.Error(), "the credentials") {
			t.Fatalf("named %q: %v", name, err)
		}
	}
}

// NodeFacts.interface_addresses lists the node's public interface
// addresses (what its git fetches refuse unless allowed), at most 64, so
// the panel can count git hosts on them as internal.
func TestInterfaceAddressesInFacts(t *testing.T) {
	old := ownPublicAddresses
	t.Cleanup(func() { ownPublicAddresses = old })
	var many []netip.Addr
	for i := range 70 {
		many = append(many, netip.AddrFrom4([4]byte{93, 184, 216, byte(i)}))
	}
	// Sorted like OwnPublicAddresses: every IPv4 address before the IPv6 ones.
	many = append(many, netip.MustParseAddr("2a01:4f8::1"), netip.MustParseAddr("2a01:4f8::2"))
	ownPublicAddresses = func() ([]netip.Addr, error) { return many, nil }
	f := &agentv1.NodeFacts{}
	refreshVolatileFacts(f, t.TempDir())
	// At most 64 per family: the IPv6 addresses are still there (before: cut after the 64th IPv4 one).
	got := f.GetInterfaceAddresses()
	if len(got) != maxInterfaceAddresses+2 || got[0] != "93.184.216.0" || got[63] != "93.184.216.63" ||
		got[64] != "2a01:4f8::1" || got[65] != "2a01:4f8::2" {
		t.Fatalf("interface addresses: %v", got)
	}
	ownPublicAddresses = func() ([]netip.Addr, error) { return nil, errors.New("no netlink") }
	refreshVolatileFacts(f, t.TempDir())
	if got := f.GetInterfaceAddresses(); got != nil {
		t.Fatalf("unreadable interfaces: %v", got)
	}
}
