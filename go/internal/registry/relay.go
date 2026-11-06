package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// LocalAddress is where Docker on every node reaches the panel registry.
const LocalAddress = docker.RegistryRelayAddress

// Relay serves LocalAddress by tunnelling connections to the panel.
type Relay interface {
	// Run listens until ctx ends, opening one RegistryTunnel stream on
	// panel per accepted connection.
	Run(ctx context.Context, panel rpc.Peer) error
}

// TCPRelay is the Relay the agent runs.
type TCPRelay struct {
	// Addr is the listen address; default LocalAddress. Tests use a high
	// port on 127.0.0.1, which Docker also treats as an insecure registry.
	Addr   string
	Logger *slog.Logger
	// Ready, if set, is called with the bound address once listening.
	Ready func(addr string)
}

var _ Relay = (*TCPRelay)(nil)

// Run implements Relay. A connection made while the panel is unreachable
// is closed at once, so `docker pull` fails fast instead of hanging.
func (r *TCPRelay) Run(ctx context.Context, panel rpc.Peer) error {
	addr := r.Addr
	if addr == "" {
		addr = LocalAddress
	}
	log := r.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("listening on %s for the registry relay: %w", addr, err)
	}
	stop := context.AfterFunc(ctx, func() { _ = ln.Close() })
	defer stop()
	if r.Ready != nil {
		r.Ready(ln.Addr().String())
	}

	open := func(ctx context.Context) (rpc.Stream, error) {
		return panel.Open(ctx, rpc.MethodRegistryTunnel, &agentv1.RegistryTunnelRequest{})
	}

	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				time.Sleep(50 * time.Millisecond)
				continue
			}
			return fmt.Errorf("registry relay accept: %w", err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			relayConn(ctx, conn, open, log)
		}()
	}
}

func relayConn(ctx context.Context, conn net.Conn, open func(context.Context) (rpc.Stream, error), log *slog.Logger) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	s, err := open(ctx)
	if err != nil {
		log.Debug("registry relay: panel unreachable", "err", err)
		_ = conn.Close()
		return
	}
	if err := pipeClient(conn, s, &agentv1.RegistryTunnelResponse{}); err != nil && ctx.Err() == nil {
		log.Debug("registry relay connection ended", "err", err)
	}
}
