package portgate

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// echoServer stands in for a container: it echoes lines back.
func echoServer(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(c, c) }()
		}
	}()
	return l.Addr().String()
}

func newManager(t *testing.T, target string, extra ...func(*Config)) *Manager {
	t.Helper()
	cfg := Config{BindIP: "127.0.0.1", Resolve: func(context.Context, string, uint32) (string, error) { return target, nil }}
	for _, f := range extra {
		f(&cfg)
	}
	m := New(cfg)
	t.Cleanup(m.Close)
	return m
}

func dialEcho(t *testing.T, port uint32) (net.Conn, error) {
	t.Helper()
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(port)), time.Second)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(c, "ping\n"); err != nil {
		return c, err
	}
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		return c, err
	}
	if line != "ping\n" {
		return c, errors.New("bad echo " + line)
	}
	return c, nil
}

func TestForwardAndPickedPort(t *testing.T) {
	file := filepath.Join(t.TempDir(), "ports.json")
	m := newManager(t, echoServer(t), func(c *Config) { c.PortsFile = file })
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil {
		t.Fatal(err)
	}
	port := ports["public-80"]
	if port == 0 {
		t.Fatal("no port picked")
	}
	c, err := dialEcho(t, port)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	if got := m.Ports("svc1"); len(got) != 1 || got[0].GetHostPort() != port || got[0].GetContainerPort() != 80 {
		t.Fatalf("ports = %v", got)
	}
	m.Close()

	// A new manager (agent restart) picks the same port again.
	m2 := newManager(t, echoServer(t), func(c *Config) { c.PortsFile = file })
	ports2, err := m2.Sync(context.Background(), "svc1", []Listener{{ID: "public-80", ContainerPort: 80}})
	if err != nil || ports2["public-80"] != port {
		t.Fatalf("after restart: %v %v, want %d", ports2, err, port)
	}
}

func TestAllowList(t *testing.T) {
	m := newManager(t, echoServer(t))
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "x", ContainerPort: 1, AllowedSourceCIDRs: []string{"10.0.0.0/8"}}})
	if err != nil {
		t.Fatal(err)
	}
	if c, err := dialEcho(t, ports["x"]); err == nil {
		_ = c.Close()
		t.Fatal("connection from outside the allow list was relayed")
	}
	// The list changes in place, same port.
	ports2, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "x", ContainerPort: 1, HostPort: ports["x"], AllowedSourceCIDRs: []string{"127.0.0.1"}}})
	if err != nil || ports2["x"] != ports["x"] {
		t.Fatalf("%v %v", ports2, err)
	}
	c, err := dialEcho(t, ports["x"])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// Narrowing the list drops the open connection it no longer admits.
	if _, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "x", ContainerPort: 1, HostPort: ports["x"], AllowedSourceCIDRs: []string{"10.0.0.0/8"}}}); err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(time.Second))
	_, _ = io.WriteString(c, "again\n")
	if line, err := bufio.NewReader(c).ReadString('\n'); err == nil {
		t.Fatalf("connection survived a narrower allow list: %q", line)
	}
}

func TestTimedExposeExpiresWithOpenConnections(t *testing.T) {
	changed := make(chan string, 4)
	m := newManager(t, echoServer(t), func(c *Config) { c.OnChange = func(id string) { changed <- id } })
	_, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "expose-a", ContainerPort: 1, Timed: true, RequireAllowList: true}})
	if !errors.Is(err, ErrNoAllowList) {
		t.Fatalf("timed expose without allow list: %v", err)
	}
	expires := time.Now().Add(400 * time.Millisecond)
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "expose-a", ContainerPort: 1, Timed: true, RequireAllowList: true, AllowedSourceCIDRs: []string{"127.0.0.1/32"}, ExpiresAt: expires}})
	if err != nil {
		t.Fatal(err)
	}
	if p := m.Ports("svc1"); len(p) != 1 || !p[0].GetExpiresAt().AsTime().Equal(expires.Truncate(time.Nanosecond)) {
		t.Fatalf("ports = %v", p)
	}
	c, err := dialEcho(t, ports["expose-a"])
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	time.Sleep(700 * time.Millisecond)
	_ = c.SetDeadline(time.Now().Add(time.Second))
	if _, err := io.WriteString(c, "x\n"); err == nil {
		if _, err := bufio.NewReader(c).ReadString('\n'); err == nil {
			t.Fatal("connection still relayed after expiry")
		}
	}
	if _, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(ports["expose-a"])), 300*time.Millisecond); err == nil {
		t.Fatal("listener still open after expiry")
	}
	if len(m.Ports("svc1")) != 0 {
		t.Fatal("expired port still reported")
	}
	// A sync with the same, past expiry does not reopen it.
	if ports, _ := m.Sync(context.Background(), "svc1", []Listener{{ID: "expose-a", ContainerPort: 1, Timed: true, RequireAllowList: true, AllowedSourceCIDRs: []string{"127.0.0.1/32"}, ExpiresAt: expires}}); len(ports) != 0 {
		t.Fatalf("reopened: %v", ports)
	}
	select {
	case id := <-changed:
		if id != "svc1" {
			t.Fatal(id)
		}
	case <-time.After(time.Second):
		t.Fatal("no change notification")
	}
}

func TestRedirectModeAndHandoff(t *testing.T) {
	var handoffs atomic.Int32
	m := newManager(t, echoServer(t), func(c *Config) {
		c.Handoff = func(r *http.Request, target string) string {
			if len(r.Cookies()) > 0 {
				handoffs.Add(1)
				return target + "/_seylo/handoff?t=tok"
			}
			return target + r.URL.RequestURI()
		}
	})
	ports, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-3000", ContainerPort: 3000, Mode: ModeRedirect, RedirectURL: "https://app.example.com/"}})
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	base := "http://127.0.0.1:" + strconv.Itoa(int(ports["public-3000"]))
	resp, err := client.Get(base + "/dash?x=1")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusPermanentRedirect || resp.Header.Get("Location") != "https://app.example.com/dash?x=1" {
		t.Fatalf("%d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	req, _ := http.NewRequest(http.MethodGet, base+"/", nil)
	req.AddCookie(&http.Cookie{Name: "sid", Value: "1"})
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if !strings.HasSuffix(resp.Header.Get("Location"), "/_seylo/handoff?t=tok") || handoffs.Load() != 1 {
		t.Fatalf("handoff: %s", resp.Header.Get("Location"))
	}

	// Forward -> redirect on the same port switches the socket.
	ports2, err := m.Sync(context.Background(), "svc1", []Listener{{ID: "public-3000", ContainerPort: 3000, HostPort: ports["public-3000"]}})
	if err != nil || ports2["public-3000"] != ports["public-3000"] {
		t.Fatalf("%v %v", ports2, err)
	}
	c, err := dialEcho(t, ports2["public-3000"])
	if err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
}

func TestListenersForAndSyncAll(t *testing.T) {
	closeAt := time.Now().Add(time.Hour)
	spec := &agentv1.ServiceSpec{
		Id: "db1",
		Ports: []*agentv1.PortSpec{
			{ContainerPort: 3000, Public: &agentv1.PublicPort{HostPort: 0, Mode: agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT, RedirectUrl: "https://a.example.com", CloseAt: timestamppb.New(closeAt)}},
			{ContainerPort: 27015, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_UDP, Public: &agentv1.PublicPort{}},
			{ContainerPort: 9000},
		},
		DevAccess: &agentv1.DevAccess{TimedExposes: []*agentv1.TimedExpose{{Id: "t1", ContainerPort: 8080, AllowedSourceCidrs: []string{"127.0.0.1/32"}, ExpiresAt: timestamppb.New(closeAt)}}},
		KindSpec: &agentv1.ServiceSpec_Database{Database: &agentv1.DatabaseSpec{Engine: agentv1.DatabaseEngine_DATABASE_ENGINE_POSTGRES,
			Exposure: &agentv1.DatabaseExposure{Enabled: true, AllowedSourceCidrs: []string{"127.0.0.1/32"}}}},
	}
	ls, errs := ListenersFor(spec)
	if len(errs) != 1 || !errors.Is(errs[0], ErrUDP) {
		t.Fatalf("errs = %v", errs)
	}
	byID := map[string]Listener{}
	for _, l := range ls {
		byID[l.ID] = l
	}
	if l := byID["public-3000"]; l.Mode != ModeRedirect || !l.ExpiresAt.Equal(closeAt.Truncate(0)) && l.ExpiresAt.Unix() != closeAt.Unix() {
		t.Fatalf("public: %+v", l)
	}
	if l := byID["expose-t1"]; !l.Timed || !l.RequireAllowList || l.ContainerPort != 8080 {
		t.Fatalf("expose: %+v", l)
	}
	if l := byID["database"]; l.ContainerPort != 5432 {
		t.Fatalf("database: %+v", l)
	}

	m := newManager(t, echoServer(t))
	err := m.SyncAll(context.Background(), &agentv1.DesiredState{Services: []*agentv1.ServiceSpec{spec}})
	if !errors.Is(err, ErrUDP) {
		t.Fatalf("SyncAll err = %v", err)
	}
	if n := len(m.Ports("db1")); n != 3 {
		t.Fatalf("open ports = %d", n)
	}
	if err := m.SyncAll(context.Background(), &agentv1.DesiredState{}); err != nil {
		t.Fatal(err)
	}
	if n := len(m.Ports("db1")); n != 0 {
		t.Fatalf("service removed but %d ports open", n)
	}
}
