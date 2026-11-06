package registry

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

func TestScopePolicy(t *testing.T) {
	p := newScopePolicy(&agentv1.RegistryScope{NodeId: "nodeb", Pull: []string{"mine"}, Push: []string{"build"}})
	cases := []struct {
		method, target string
		allowed        bool
	}{
		{"GET", "/v2/", true},
		{"HEAD", "/v2/", true},
		{"GET", "/v2/_catalog", false},
		{"GET", "/v2/_catalog?n=100", false},
		{"GET", "/v2/mine/manifests/7", true},
		{"HEAD", "/v2/mine/manifests/sha256:ab", true},
		{"GET", "/v2/mine/blobs/sha256:ab", true},
		{"GET", "/v2/mine/tags/list", true},
		{"GET", "/v2/mine/referrers/sha256:ab", true},
		{"PUT", "/v2/mine/manifests/7", false},
		{"POST", "/v2/mine/blobs/uploads/", false},
		{"DELETE", "/v2/mine/manifests/sha256:ab", false},
		{"DELETE", "/v2/build/manifests/sha256:ab", false},
		{"DELETE", "/v2/build/blobs/sha256:ab", false},
		{"GET", "/v2/other/manifests/7", false},
		{"GET", "/v2/other/blobs/sha256:ab", false},
		{"GET", "/v2/other/tags/list", false},
		{"GET", "/v2/build/manifests/7", true}, // push implies pull
		{"PUT", "/v2/build/manifests/7", true},
		{"POST", "/v2/build/blobs/uploads/", true},
		{"PATCH", "/v2/build/blobs/uploads/0b1d2e", true},
		{"PUT", "/v2/build/blobs/uploads/0b1d2e?digest=sha256:ab", true},
		{"DELETE", "/v2/build/blobs/uploads/0b1d2e", true}, // cancels an upload, deletes no content
		{"POST", "/v2/other/blobs/uploads/", false},
		{"GET", "/v2/mine/manifests/../../other/manifests/7", false},
		{"GET", "/v2/mine%2Fx/manifests/7", false},
		{"GET", "/v2//mine/manifests/7", false},
		{"GET", "/v2/a/b/manifests/7", false},
		{"GET", "/other", false},
		{"OPTIONS", "/v2/mine/manifests/7", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "http://127.0.0.1:5755"+c.target, nil)
		if got := p.check(r) == ""; got != c.allowed {
			t.Errorf("%s %s: allowed %v, want %v (%s)", c.method, c.target, got, c.allowed, p.check(r))
		}
	}
}

func TestScopeStripsForeignBlobMounts(t *testing.T) {
	p := newScopePolicy(&agentv1.RegistryScope{Pull: []string{"mine"}, Push: []string{"build"}})
	for target, keep := range map[string]bool{
		"/v2/build/blobs/uploads/?mount=sha256:ab&from=other": false,
		"/v2/build/blobs/uploads/?mount=sha256:ab":            false, // any repository
		"/v2/build/blobs/uploads/?mount=sha256:ab&from=mine":  true,
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:5755"+target, nil)
		if reason := p.check(r); reason != "" {
			t.Fatalf("%s refused: %s", target, reason)
		}
		q := r.URL.Query()
		kept := q.Get("mount") == "sha256:ab" && q.Get("from") == "mine"
		if kept != keep || (!keep && (q.Has("mount") || q.Has("from"))) {
			t.Errorf("%s: query after check %q", target, r.URL.RawQuery)
		}
	}
}

// scopedBridge plays the panel with a scope, as registryTunnel does for a
// node's relayed connection.
type scopedBridge struct {
	node *rpctest.Peer
	mu   sync.Mutex
	// scope is what the "panel" sends now; tests may change it between
	// connections (a build that ended, a new placement).
	scope *agentv1.RegistryScope
}

func (p *scopedBridge) Call(context.Context, string, proto.Message, proto.Message) error {
	return errors.New("not used")
}

func (p *scopedBridge) Notify(context.Context, *agentv1.Event) error { return nil }

func (p *scopedBridge) Open(ctx context.Context, _ string, _ proto.Message) (rpc.Stream, error) {
	p.mu.Lock()
	scope := p.scope
	p.mu.Unlock()
	return p.node.Open(ctx, "Tunnel", &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{Scope: scope}}})
}

// A node's relayed connection only reaches the registry for what its
// scope allows; refused requests never arrive there.
func TestScopedTunnelEndToEnd(t *testing.T) {
	blob := make([]byte, 3<<20)
	_, _ = rand.Read(blob)
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()
		switch {
		case r.Method == http.MethodHead:
			w.Header().Set("Content-Length", "1234")
			w.Header().Set("Docker-Content-Digest", "sha256:ab")
		case r.Method == http.MethodPatch:
			n, _ := io.Copy(io.Discard, r.Body)
			w.Header().Set("Range", "0-"+itoa(n-1))
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodPost:
			w.Header().Set("Location", "http://"+r.Host+"/v2/build/blobs/uploads/u1")
			w.WriteHeader(http.StatusAccepted)
		default:
			_, _ = w.Write(blob)
		}
	}))
	defer srv.Close()

	reg := rpc.NewAgentMux()
	rpc.HandleRaw(reg, "Tunnel", (&Tunnel{Dial: fixedDialer{addr: srv.Listener.Addr().String()}}).Serve)
	node := rpctest.NewPeer(t, reg, rpctest.WithWindow(16<<10))
	addr := startRelay(t, &scopedBridge{node: node, scope: &agentv1.RegistryScope{NodeId: "nodeb", Pull: []string{"mine"}, Push: []string{"build"}}})
	client := &http.Client{Timeout: 20 * time.Second}
	do := func(method, path string, body io.Reader) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(method, "http://"+addr+path, body)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, b
	}

	// Several requests on one kept-alive connection, like docker pull.
	if resp, b := do("GET", "/v2/mine/blobs/sha256:ab", nil); resp.StatusCode != 200 || !bytes.Equal(b, blob) {
		t.Fatalf("pull: %d, %d bytes", resp.StatusCode, len(b))
	}
	if resp, _ := do("HEAD", "/v2/mine/manifests/7", nil); resp.StatusCode != 200 || resp.ContentLength != 1234 || resp.Header.Get("Docker-Content-Digest") != "sha256:ab" {
		t.Fatalf("head: %d, length %d", resp.StatusCode, resp.ContentLength)
	}
	resp, _ := do("POST", "/v2/build/blobs/uploads/?mount=sha256:ab&from=other", nil)
	if resp.StatusCode != http.StatusAccepted || !strings.HasPrefix(resp.Header.Get("Location"), "http://"+addr+"/") {
		t.Fatalf("upload start: %d, location %q (the registry must see the relay's Host)", resp.StatusCode, resp.Header.Get("Location"))
	}
	up := make([]byte, 2<<20)
	_, _ = rand.Read(up)
	// A chunked upload (unknown length).
	if resp, _ := do("PATCH", "/v2/build/blobs/uploads/u1", io.MultiReader(bytes.NewReader(up))); resp.StatusCode != http.StatusAccepted || resp.Header.Get("Range") != "0-"+itoa(int64(len(up))-1) {
		t.Fatalf("chunked upload: %d, range %q", resp.StatusCode, resp.Header.Get("Range"))
	}

	for _, refused := range [][2]string{
		{"GET", "/v2/_catalog"},
		{"GET", "/v2/other/manifests/7"},
		{"DELETE", "/v2/mine/manifests/sha256:ab"},
		{"PUT", "/v2/mine/manifests/7"},
	} {
		resp, b := do(refused[0], refused[1], nil)
		if resp.StatusCode != http.StatusForbidden || !strings.Contains(string(b), "DENIED") {
			t.Fatalf("%s %s: %d %s", refused[0], refused[1], resp.StatusCode, b)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"GET /v2/mine/blobs/sha256:ab", "HEAD /v2/mine/manifests/7", "POST /v2/build/blobs/uploads/", "PATCH /v2/build/blobs/uploads/u1"}
	if strings.Join(seen, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the registry saw:\n%s\nwant:\n%s", strings.Join(seen, "\n"), strings.Join(want, "\n"))
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
