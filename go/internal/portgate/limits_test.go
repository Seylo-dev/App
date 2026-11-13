package portgate

import (
	"bufio"
	"context"
	"io"
	"net"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A flood of connections to a public port costs one Resolve (Docker
// lookups) per ResolveTTL, not one per connection.
func TestResolveIsSharedAcrossConnections(t *testing.T) {
	target := echoServer(t)
	var calls atomic.Int32
	m := newManager(t, "", func(c *Config) {
		c.Resolve = func(context.Context, string, uint32) (string, error) {
			calls.Add(1)
			time.Sleep(20 * time.Millisecond) // a Docker round trip
			return target, nil
		}
		c.ResolveTTL = time.Minute
	})
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var failed atomic.Int32
	for range 40 {
		wg.Go(func() {
			c, err := dialEcho(t, ports["public-80"])
			if c != nil {
				_ = c.Close()
			}
			if err != nil {
				failed.Add(1)
			}
		})
	}
	wg.Wait()
	if failed.Load() != 0 {
		t.Fatalf("%d connections failed", failed.Load())
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("Resolve ran %d times for 40 connections, want 1", n)
	}
}

// A cached address that stopped answering (new generation) is looked up
// again at once.
func TestStaleResolveIsRefreshed(t *testing.T) {
	old, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	oldAddr := old.Addr().String()
	_ = old.Close()
	current := atomic.Value{}
	current.Store(oldAddr)
	m := newManager(t, "", func(c *Config) {
		c.Resolve = func(context.Context, string, uint32) (string, error) { return current.Load().(string), nil }
		c.ResolveTTL = time.Minute
		// The first client is closed before its own 2-second deadline. The
		// refused address counts as a failed lookup for resolveErrorTTL, so
		// the second client may wait up to that long for the next lookup.
		c.ConnectTimeout = 1500 * time.Millisecond
	})
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	if c, err := dialEcho(t, ports["public-80"]); err == nil {
		_ = c.Close()
		t.Fatal("relayed to a closed address")
	}
	current.Store(echoServer(t))
	c, err := dialEcho(t, ports["public-80"])
	if err != nil {
		t.Fatalf("the moved container was not looked up again: %v", err)
	}
	_ = c.Close()
}

func dialRaw(t *testing.T, port uint32) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// closedSoon reports whether the gate closed c (EOF or reset) within d.
func closedSoon(c net.Conn, d time.Duration) bool {
	_ = c.SetReadDeadline(time.Now().Add(d))
	_, err := c.Read(make([]byte, 1))
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		return false
	}
	return err != nil
}

func TestConnectionCaps(t *testing.T) {
	m := newManager(t, echoServer(t), func(c *Config) { c.MaxConns = 3; c.MaxConnsPerSource = 2 })
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	port := ports["public-80"]
	first, err := dialEcho(t, port)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := dialEcho(t, port)
	if err != nil {
		t.Fatal(err)
	}
	// A third connection from the same address is over the per-source cap.
	third := dialRaw(t, port)
	if !closedSoon(third, time.Second) {
		t.Fatal("a third connection from one address was kept")
	}
	// Closing one frees a slot.
	_ = second.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		c, err := dialEcho(t, port)
		if err == nil {
			_ = c.Close()
			break
		}
		if c != nil {
			_ = c.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("no slot after a client left: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestIdleConnectionsAreCut(t *testing.T) {
	m := newManager(t, echoServer(t), func(c *Config) { c.IdleTimeout = 300 * time.Millisecond })
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	idle, err := dialEcho(t, ports["public-80"])
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
	busy, err := dialEcho(t, ports["public-80"])
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	_ = busy.SetDeadline(time.Time{})
	r := bufio.NewReader(busy)
	for range 6 {
		time.Sleep(100 * time.Millisecond)
		if _, err := io.WriteString(busy, "tick\n"); err != nil {
			t.Fatalf("a busy connection was cut: %v", err)
		}
		_ = busy.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := r.ReadString('\n'); err != nil {
			t.Fatalf("a busy connection was cut: %v", err)
		}
	}
	// 600 ms passed with traffic on busy only: idle is gone.
	if !closedSoon(idle, 100*time.Millisecond) {
		t.Fatal("an idle connection was kept past the idle timeout")
	}
}

// Each listener cuts idle connections after its own IdleTimeout (a
// database's: DatabaseIdleTimeout); Config.IdleTimeout, when set, is for
// every listener.
func TestListenerIdleTimeout(t *testing.T) {
	m := newManager(t, echoServer(t))
	ports, err := m.Sync(context.Background(), "svc1", []Listener{
		{ID: "expose-short", ContainerPort: 1, IdleTimeout: 300 * time.Millisecond},
		{ID: "expose-default", ContainerPort: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	short, err := dialEcho(t, ports["expose-short"])
	if err != nil {
		t.Fatal(err)
	}
	defer short.Close()
	other, err := dialEcho(t, ports["expose-default"])
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if !closedSoon(short, 900*time.Millisecond) {
		t.Fatal("the listener's idle timeout did not cut an idle connection")
	}
	if closedSoon(other, 100*time.Millisecond) {
		t.Fatal("a listener without its own idle timeout cut a connection after 1 s")
	}
	// A changed timeout reopens the listener on the same port.
	again, err := m.Sync(context.Background(), "svc1", []Listener{
		{ID: "expose-short", ContainerPort: 1, HostPort: ports["expose-short"], IdleTimeout: time.Hour},
		{ID: "expose-default", ContainerPort: 1, HostPort: ports["expose-default"]},
	})
	if err != nil || again["expose-short"] != ports["expose-short"] {
		t.Fatalf("%v %v", again, err)
	}
	c, err := dialEcho(t, ports["expose-short"])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if closedSoon(c, 600*time.Millisecond) {
		t.Fatal("the old idle timeout still applies")
	}
}

func TestListening(t *testing.T) {
	m := newManager(t, echoServer(t))
	if got := m.Listening(); len(got) != 0 {
		t.Fatalf("listening before any sync: %v", got)
	}
	a, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}, {ID: "database", ContainerPort: 5432}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Sync(context.Background(), "svc2", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	got := m.Listening()
	if len(got) != 3 || !slices.Contains(got, a["public-80"]) || !slices.Contains(got, a["database"]) || !slices.Contains(got, b["public-80"]) {
		t.Fatalf("listening %v, opened %v %v", got, a, b)
	}
}
