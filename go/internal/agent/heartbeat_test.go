package agent

import (
	"context"
	"io"
	"net"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/rpc/rpctest"
)

// freezeProxy forwards TCP to target. While frozen it keeps connections
// open but moves no bytes: a panel that vanished without a FIN.
type freezeProxy struct {
	ln     net.Listener
	frozen atomic.Bool
	mu     sync.Mutex
	conns  []net.Conn
}

func newFreezeProxy(t *testing.T, target string) *freezeProxy {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &freezeProxy{ln: ln}
	t.Cleanup(func() {
		ln.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			c.Close()
		}
		p.mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, up)
			p.mu.Unlock()
			go p.pipe(c, up)
			go p.pipe(up, c)
		}
	}()
	return p
}

func (p *freezeProxy) pipe(dst, src net.Conn) {
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		for p.frozen.Load() {
			time.Sleep(5 * time.Millisecond) // hold the bytes, keep the socket open
		}
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			if err != io.EOF {
				dst.Close()
			}
			return
		}
	}
}

func TestHeartbeatDetectsSilentPanel(t *testing.T) {
	isolate(t)
	saved := []time.Duration{pingEvery, pingTimeout}
	t.Cleanup(func() { pingEvery, pingTimeout = saved[0], saved[1] })
	pingEvery, pingTimeout = 50*time.Millisecond, 100*time.Millisecond

	panel := rpctest.NewFakePanel(t)
	panel.AddJoinToken("hb")
	u, _ := url.Parse(panel.URL())
	proxy := newFreezeProxy(t, u.Host)
	layout := shortLayout(t)
	if err := Join(layout, JoinOptions{PanelURL: "http://" + proxy.ln.Addr().String(), Token: "hb"}); err != nil {
		t.Fatal(err)
	}
	a := startDaemon(t, layout)
	nodeID := panel.WaitConnected("")
	waitUntil(t, "connected", func() bool { s, _ := a.d.backend.Status(context.Background()); return s.PanelConnected })

	proxy.frozen.Store(true)
	waitUntil(t, "the agent to notice the silent panel", func() bool {
		s, _ := a.d.backend.Status(context.Background())
		return !s.PanelConnected
	})
	s, _ := a.d.backend.Status(context.Background())
	if len(s.RecentErrors) == 0 || s.RecentErrors[len(s.RecentErrors)-1].Source != "connection" {
		t.Fatalf("status after the ping timeout = %+v", s)
	}
	t.Logf("detected: %s", s.Connection.LastError)

	// The fake panel still holds the old session; drop it so the resume is
	// not refused as already connected, then let bytes flow again.
	panel.DropConnections()
	proxy.frozen.Store(false)
	waitUntil(t, "a reconnect", func() bool { s, _ := a.d.backend.Status(context.Background()); return s.PanelConnected })
	panel.WaitConnected(nodeID)
}
