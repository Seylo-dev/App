package registry

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// TestRelayOverRealSessions runs the production chain with real rpc
// sessions and frames (credit windows, CLOSE ordering), where the Go
// "panel" plays apps/panel's registryTunnel: node relay -> RegistryTunnel
// on the panel session -> Tunnel(RegistryTarget) on the node's session ->
// the "registry" (an httptest server).
func TestRelayOverRealSessions(t *testing.T) {
	blob := make([]byte, 6<<20)
	_, _ = rand.Read(blob)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			_, _ = io.Copy(w, r.Body)
			return
		}
		_, _ = w.Write(blob)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	agentEnd, panelEnd := conn.Pipe()

	agentMux := rpc.NewAgentMux()
	rpc.HandleRaw(agentMux, "Tunnel", (&Tunnel{Dial: fixedDialer{addr: srv.Listener.Addr().String()}}).Serve)

	var panelSession *rpc.Session
	panelMux := rpc.NewPanelMux()
	rpc.HandleRaw(panelMux, "RegistryTunnel", func(ctx context.Context, _ *agentv1.RegistryTunnelRequest, s rpc.RawStream) (*agentv1.RegistryTunnelResponse, error) {
		up, err := panelSession.Open(ctx, "Tunnel", &agentv1.TunnelRequest{Target: &agentv1.TunnelRequest_Registry{Registry: &agentv1.RegistryTarget{}}})
		if err != nil {
			return nil, err
		}
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = io.Copy(up, s) // agent -> registry until the agent half-closes
			_ = up.CloseSend()
		}()
		_, err = io.Copy(s, up) // registry -> agent until the registry side closes
		wg.Wait()
		if ferr := up.Finish(&agentv1.TunnelResponse{}); err == nil {
			err = ferr
		}
		return &agentv1.RegistryTunnelResponse{}, err
	})

	agentSession := rpc.NewSession(rpc.SessionConfig{Transport: agentEnd, Role: conn.RoleDialer, Handlers: agentMux, PeerCapabilities: panelMux.Capabilities(), InitialWindow: 64 << 10})
	panelSession = rpc.NewSession(rpc.SessionConfig{Transport: panelEnd, Role: conn.RoleAcceptor, Handlers: panelMux, PeerCapabilities: agentMux.Capabilities(), InitialWindow: 64 << 10})
	go func() { _ = agentSession.Serve(ctx) }()
	go func() { _ = panelSession.Serve(ctx) }()
	defer agentSession.Close(nil)
	defer panelSession.Close(nil)

	addr := startRelay(t, agentSession)
	client := &http.Client{Timeout: 30 * time.Second}

	// Several connections at once, like a docker push of several layers.
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				resp, err := client.Get("http://" + addr + "/v2/blob")
				if err != nil {
					errs <- err
					return
				}
				got, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if !bytes.Equal(got, blob) {
					errs <- io.ErrUnexpectedEOF
				}
				return
			}
			up := make([]byte, 3<<20)
			_, _ = rand.Read(up)
			req, _ := http.NewRequest(http.MethodPut, "http://"+addr+"/v2/upload", bytes.NewReader(up))
			resp, err := client.Do(req)
			if err != nil {
				errs <- err
				return
			}
			got, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if !bytes.Equal(got, up) {
				errs <- io.ErrShortWrite
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("%v (agent session: %v, panel session: %v)", err, agentSession.Err(), panelSession.Err())
	}
}
