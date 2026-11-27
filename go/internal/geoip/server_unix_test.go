//go:build unix

package geoip

import (
	"net"
	"os"
	"strconv"
	"syscall"
	"testing"
)

func TestListenerFromSystemd(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f, err := l.(*net.TCPListener).File()
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
	defer f.Close()
	// listener takes over the descriptor it is given (systemd's is 3), so
	// it gets a copy of f's.
	fd, err := syscall.Dup(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LISTEN_PID", strconv.Itoa(os.Getpid()))
	t.Setenv("LISTEN_FDS", "1")
	got, err := listener("", uintptr(fd))
	if err != nil {
		t.Fatal(err)
	}
	defer got.Close()
	if os.Getenv("LISTEN_FDS") != "" || os.Getenv("LISTEN_PID") != "" {
		t.Error("LISTEN_FDS and LISTEN_PID stay set for children")
	}
	conn, err := net.Dial("tcp", got.Addr().String())
	if err != nil {
		t.Fatalf("dialing the handed-over socket: %v", err)
	}
	conn.Close()
}
