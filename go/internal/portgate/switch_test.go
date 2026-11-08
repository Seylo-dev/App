package portgate

// Deploys switch a service to new containers while first-run IP:port
// clients keep sending requests. The 0.2.0 install tests saw one request
// hang at the switch (a cached address of the removed container) and,
// seconds later, a second of connection resets (a failed lookup was
// cached and every connection in that second was closed unread). These
// tests switch the target under a fake resolver.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// namedServer stands in for one container: it answers each line with
// "<name>:<line>".
func namedServer(t *testing.T, name string) (addr string, stop func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	conns := map[net.Conn]bool{}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns[c] = true
			mu.Unlock()
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if _, err := io.WriteString(c, name+":"+line); err != nil {
						return
					}
				}
			}()
		}
	}()
	var once sync.Once
	stop = func() {
		once.Do(func() {
			_ = l.Close()
			mu.Lock()
			for c := range conns {
				_ = c.Close()
			}
			mu.Unlock()
		})
	}
	t.Cleanup(stop)
	return l.Addr().String(), stop
}

// gateConn is one connection through the gate.
type gateConn struct {
	c net.Conn
	r *bufio.Reader
}

func open(t *testing.T, port uint32) *gateConn {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(port)), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return &gateConn{c: c, r: bufio.NewReader(c)}
}

// ask sends line and returns the answer, within wait.
func (c *gateConn) ask(line string, wait time.Duration) (string, error) {
	_ = c.c.SetDeadline(time.Now().Add(wait))
	if _, err := io.WriteString(c.c, line+"\n"); err != nil {
		return "", err
	}
	got, err := c.r.ReadString('\n')
	return strings.TrimSuffix(got, "\n"), err
}

// target is what the fake resolver answers.
type target struct {
	mu    sync.Mutex
	addr  string
	err   error
	calls atomic.Int32
}

func (f *target) set(addr string, err error) {
	f.mu.Lock()
	f.addr, f.err = addr, err
	f.mu.Unlock()
}

func (f *target) resolve(context.Context, string, uint32) (string, error) {
	f.calls.Add(1)
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.addr, f.err
}

func gateFor(t *testing.T, f *target, extra ...func(*Config)) (*Manager, uint32) {
	t.Helper()
	m := newManager(t, "", append([]func(*Config){func(c *Config) {
		c.Resolve = f.resolve
		c.ResolveTTL = time.Minute // the cache is what these tests are about
	}}, extra...)...)
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	return m, ports["public-80"]
}

// The target changes mid-stream: an open connection stays on the old
// container, new ones follow the switch as soon as reconcile reports it.
func TestSwitchMidStream(t *testing.T) {
	a, _ := namedServer(t, "a")
	b, _ := namedServer(t, "b")
	f := &target{addr: a}
	m, port := gateFor(t, f)

	stream := open(t, port)
	if got, err := stream.ask("1", 2*time.Second); err != nil || got != "a:1" {
		t.Fatalf("first request: %q %v", got, err)
	}
	f.set(b, nil)
	// Still the cached lookup: the old container keeps serving until the switch.
	if got, err := open(t, port).ask("2", 2*time.Second); err != nil || got != "a:2" {
		t.Fatalf("before the switch: %q %v", got, err)
	}
	m.Switched("svc1")
	if got, err := open(t, port).ask("3", 2*time.Second); err != nil || got != "b:3" {
		t.Fatalf("after the switch: %q %v (before: the cached address of the old container)", got, err)
	}
	if got, err := stream.ask("4", 2*time.Second); err != nil || got != "a:4" {
		t.Fatalf("the open stream after the switch: %q %v", got, err)
	}
}

// The old container was removed while its address was still cached, and
// that address swallows the SYN. Before: the connection hung for the whole
// wait and failed. Now the cached address gets a second at most, then a
// fresh lookup.
func TestRemovedContainerAddressIsLeftQuickly(t *testing.T) {
	a, _ := namedServer(t, "a")
	b, _ := namedServer(t, "b")
	const oldIP, newIP = "10.0.3.4:80", "10.0.3.5:80"
	var removed atomic.Bool
	f := &target{addr: oldIP}
	_, port := gateFor(t, f, func(c *Config) {
		c.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
			switch {
			case addr == oldIP && removed.Load():
				<-ctx.Done() // gone from the bridge: no answer at all
				return nil, ctx.Err()
			case addr == oldIP:
				addr = a
			case addr == newIP:
				addr = b
			}
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}
	})
	if got, err := open(t, port).ask("1", 2*time.Second); err != nil || got != "a:1" {
		t.Fatalf("first request: %q %v", got, err)
	}
	// The deploy: new container, old one destroyed in the same second.
	f.set(newIP, nil)
	removed.Store(true)
	start := time.Now()
	got, err := open(t, port).ask("2", 3*time.Second)
	if err != nil || got != "b:2" {
		t.Fatalf("after the old container went: %q %v", got, err)
	}
	if took := time.Since(start); took > cachedDialTimeout+time.Second {
		t.Fatalf("took %s to leave the removed container's address", took)
	}
	// The address that failed is not dialed again.
	start = time.Now()
	if got, err := open(t, port).ask("3", 2*time.Second); err != nil || got != "b:3" || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("next request: %q %v after %s", got, err, time.Since(start))
	}
}

// A lookup fails for a moment during the switch. Before: the failure was
// cached and every connection of that second was closed unread (a reset).
// Now connections wait for the next lookup and are served.
func TestFailedLookupDuringSwitchIsWaitedOut(t *testing.T) {
	b, _ := namedServer(t, "b")
	f := &target{err: errors.New("no running instance of svc1")}
	_, port := gateFor(t, f)
	first, second := open(t, port), open(t, port)
	type answer struct {
		got string
		err error
	}
	answers := make(chan answer, 2)
	for i, c := range []*gateConn{first, second} {
		go func() {
			got, err := c.ask(strconv.Itoa(i), 4*time.Second)
			answers <- answer{got, err}
		}()
	}
	time.Sleep(300 * time.Millisecond)
	f.set(b, nil)
	for range 2 {
		if a := <-answers; a.err != nil || !strings.HasPrefix(a.got, "b:") {
			t.Fatalf("a connection during the failed lookup: %q %v (before: reset at once)", a.got, a.err)
		}
	}
	// Docker was asked once per resolveErrorTTL, not per connection or per try.
	if n := f.calls.Load(); n > 3 {
		t.Fatalf("Resolve ran %d times", n)
	}
}

// A failed lookup is not kept across a switch.
func TestSwitchedDropsAFailedLookup(t *testing.T) {
	b, _ := namedServer(t, "b")
	f := &target{err: errors.New("no running instance of svc1")}
	m, port := gateFor(t, f, func(c *Config) { c.ConnectTimeout = 200 * time.Millisecond })
	if _, err := open(t, port).ask("1", time.Second); err == nil {
		t.Fatal("served while nothing runs")
	}
	f.set(b, nil)
	m.Switched("svc1")
	start := time.Now()
	if got, err := open(t, port).ask("2", time.Second); err != nil || got != "b:2" {
		t.Fatalf("after the switch: %q %v", got, err)
	}
	if took := time.Since(start); took > 300*time.Millisecond {
		t.Fatalf("waited %s for the failed lookup to expire", took)
	}
}

// The new container is up but does not listen yet (the lookup finds it
// first). Before: the refused dial closed the client at once. Now it is
// tried again until the container listens.
func TestRefusedAddressIsTriedAgain(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	_ = probe.Close()
	f := &target{addr: addr}
	_, port := gateFor(t, f)
	c := open(t, port)
	answer := make(chan string, 1)
	go func() {
		got, err := c.ask("1", 4*time.Second)
		if err != nil {
			got = err.Error()
		}
		answer <- got
	}()
	time.Sleep(400 * time.Millisecond)
	l, err := net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("the port was taken meanwhile: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		s, err := l.Accept()
		if err != nil {
			return
		}
		defer s.Close()
		line, _ := bufio.NewReader(s).ReadString('\n')
		_, _ = io.WriteString(s, "late:"+line)
	}()
	if got := <-answer; got != "late:1" {
		t.Fatalf("got %q (before: reset at once)", got)
	}
}

// A service that stays down: connections are closed once the wait is
// over, Docker is asked about once a second for all of them, and the
// warning is written once.
func TestServiceDownClosesAfterTheWait(t *testing.T) {
	f := &target{err: errors.New("no running instance of svc1")}
	var logs bytes.Buffer
	var logMu sync.Mutex
	_, port := gateFor(t, f, func(c *Config) {
		c.ConnectTimeout = 700 * time.Millisecond
		c.Logger = slog.New(slog.NewTextHandler(writerFunc(func(p []byte) (int, error) {
			logMu.Lock()
			defer logMu.Unlock()
			return logs.Write(p)
		}), nil))
	})
	start := time.Now()
	var wg sync.WaitGroup
	for i := range 20 {
		c := open(t, port)
		wg.Go(func() {
			if got, err := c.ask(strconv.Itoa(i), 3*time.Second); err == nil {
				t.Errorf("served %q while the service is down", got)
			}
		})
	}
	wg.Wait()
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("connections were held %s", took)
	}
	if n := f.calls.Load(); n > 2 {
		t.Fatalf("Resolve ran %d times for 20 connections in under a second", n)
	}
	logMu.Lock()
	defer logMu.Unlock()
	if n := strings.Count(logs.String(), "portgate cannot reach the service"); n != 1 {
		t.Fatalf("warned %d times:\n%s", n, logs.String())
	}
}

type writerFunc func([]byte) (int, error)

func (w writerFunc) Write(p []byte) (int, error) { return w(p) }
