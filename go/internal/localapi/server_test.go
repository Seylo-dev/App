package localapi

import (
	"context"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fakeBackend struct{}

func (fakeBackend) Status(context.Context) (NodeStatus, error)              { return NodeStatus{}, nil }
func (fakeBackend) Version() VersionInfo                                    { return VersionInfo{Version: "test"} }
func (fakeBackend) PanelStatus(context.Context) (PanelStatus, error)        { return PanelStatus{}, nil }
func (fakeBackend) StartPanel(context.Context) error                        { return nil }
func (fakeBackend) PanelLogs(context.Context, LogsOptions, io.Writer) error { return nil }

// shortSocket is a socket path under /tmp: unix socket paths must stay
// under about 100 bytes, which t.TempDir on macOS exceeds.
func shortSocket(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "la-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "run", "agent.sock")
}

func serve(t *testing.T, socket string) (stop func()) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, socket, fakeBackend{}, slog.New(slog.DiscardHandler)) }()
	return func() {
		t.Helper()
		cancel()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

// The CLI checks Available, then dials (`seylo status` right after the
// agent started): the path must not show up before the socket listens and
// is root only. A plain net.Listen on the path made it appear at bind,
// before listen and the chmod.
func TestSocketIsReadyOnceItExists(t *testing.T) {
	socket := shortSocket(t)
	const rounds = 200
	refused, open := 0, 0
	for range rounds {
		stop := serve(t, socket)
		deadline := time.Now().Add(5 * time.Second)
		for !Available(socket) {
			if time.Now().After(deadline) {
				t.Fatal("no socket after 5s")
			}
		}
		if info, err := os.Stat(socket); err == nil && info.Mode().Perm() != 0o600 {
			open++
		}
		if c, err := net.Dial("unix", socket); err != nil {
			refused++
		} else {
			c.Close()
		}
		stop()
		if Available(socket) {
			t.Fatal("the socket stayed after Serve returned")
		}
	}
	if refused > 0 || open > 0 {
		t.Fatalf("of %d fresh sockets, %d refused the first dial and %d were not 0600", rounds, refused, open)
	}
	if entries, _ := os.ReadDir(filepath.Dir(socket)); len(entries) != 0 {
		t.Fatalf("left in the socket folder: %v", entries)
	}
}

// A socket an agent left behind (killed before it removed it) refuses
// connections; the next agent replaces it.
func TestServeReplacesStaleSocket(t *testing.T) {
	socket := shortSocket(t)
	if err := os.MkdirAll(filepath.Dir(socket), 0o700); err != nil {
		t.Fatal(err)
	}
	stale, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	if !Available(socket) {
		t.Fatal("no stale socket to replace")
	}
	stop := serve(t, socket)
	defer stop()
	waitDial := time.Now().Add(5 * time.Second)
	for {
		v, err := NewSocketClient(socket).Version(context.Background())
		if err == nil && v.Version == "test" {
			return
		}
		if time.Now().After(waitDial) {
			t.Fatalf("version through the replaced socket = %v, %v", v, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
