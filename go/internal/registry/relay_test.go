package registry

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// panelBridge plays the panel: an agent's RegistryTunnel stream becomes a
// Tunnel(RegistryTarget) stream on the (in-process) panel node agent.
type panelBridge struct {
	node *rpctest.Peer
	down bool
}

func (p *panelBridge) Call(context.Context, string, proto.Message, proto.Message) error {
	return errors.New("not used")
}

func (p *panelBridge) Notify(context.Context, *agentv1.Event) error { return nil }

func (p *panelBridge) Open(ctx context.Context, method string, _ proto.Message) (rpc.Stream, error) {
	if p.down {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "not connected")
	}
	if method != rpc.MethodRegistryTunnel {
		return nil, errors.New("unexpected method " + method)
	}
	return p.node.Open(ctx, "Tunnel", &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{}}})
}

// fixedDialer sends every target to one address.
type fixedDialer struct{ addr string }

func (f fixedDialer) DialRegistry(ctx context.Context) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", f.addr)
}

func (f fixedDialer) DialService(ctx context.Context, _ string, _ uint32) (net.Conn, error) {
	return f.DialRegistry(ctx)
}

func startRelay(t *testing.T, panel rpc.Peer) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan string, 1)
	done := make(chan error, 1)
	r := &TCPRelay{Addr: "127.0.0.1:0", Ready: func(a string) { ready <- a }}
	go func() { done <- r.Run(ctx, panel) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("relay: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Error("relay did not stop")
		}
	})
	select {
	case a := <-ready:
		return a
	case err := <-done:
		t.Fatalf("relay: %v", err)
	}
	return ""
}

func TestRelayThroughTunnel(t *testing.T) {
	// The "registry": echoes request bodies and serves a large blob.
	blob := make([]byte, 3<<20)
	_, _ = rand.Read(blob)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = io.Copy(w, r.Body)
			return
		}
		_, _ = w.Write(blob)
	}))
	defer srv.Close()

	reg := rpc.NewAgentMux()
	tun := &Tunnel{Dial: fixedDialer{addr: srv.Listener.Addr().String()}}
	rpc.HandleRaw(reg, "Tunnel", tun.Serve)
	node := rpctest.NewPeer(t, reg, rpctest.WithWindow(16<<10))
	addr := startRelay(t, &panelBridge{node: node})

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Get("http://" + addr + "/v2/blob")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("download: %d bytes, err %v", len(got), err)
	}

	up := make([]byte, 2<<20)
	_, _ = rand.Read(up)
	resp, err = client.Post("http://"+addr+"/v2/upload", "application/octet-stream", bytes.NewReader(up))
	if err != nil {
		t.Fatal(err)
	}
	got, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !bytes.Equal(got, up) {
		t.Fatalf("upload echoed %d bytes", len(got))
	}
}

func TestRelayClosesWhenPanelIsDown(t *testing.T) {
	addr := startRelay(t, &panelBridge{down: true})
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("read on a relay without a panel: %v, want EOF", err)
	}
}

func TestTunnelRejectsBadTargets(t *testing.T) {
	reg := rpc.NewAgentMux()
	tun := &Tunnel{Dial: fixedDialer{addr: "127.0.0.1:1"}}
	rpc.HandleRaw(reg, "Tunnel", tun.Serve)
	node := rpctest.NewPeer(t, reg)
	ctx := context.Background()
	for name, req := range map[string]*agentv1.TunnelRequest{
		"no target":   {},
		"port 0":      {Target: &agentv1.TunnelRequest_ServicePort{ServicePort: &agentv1.ServicePortTarget{ServiceId: "s"}}},
		"unreachable": {Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{}}},
	} {
		s, err := node.Open(ctx, "Tunnel", req)
		if err != nil {
			t.Fatal(err)
		}
		_ = s.CloseSend()
		err = s.Finish(&agentv1.TunnelResponse{})
		if st := rpc.StatusOf(err); st.GetCode() == agentv1.StatusCode_STATUS_CODE_OK || st.GetCode() == agentv1.StatusCode_STATUS_CODE_INTERNAL {
			t.Errorf("%s: status %v", name, st)
		}
	}
}

func TestNewestContainer(t *testing.T) {
	out := "aaa\t3\nbbb\t12\nccc\t\nddd\t4\n"
	if got := newestContainer(out); got != "bbb" {
		t.Fatalf("newest = %q", got)
	}
	if got := newestContainer(""); got != "" {
		t.Fatalf("empty = %q", got)
	}
}
