package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
)

// fakeDaemon answers the two calls CreateContainer and InspectContainer
// make, and keeps the create body.
type fakeDaemon struct {
	mu      sync.Mutex
	created map[string]any
	inspect string
	// image answers GET /images/app:1/json when set.
	image string
}

func (f *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/containers/create"):
		body, _ := io.ReadAll(r.Body)
		var v map[string]any
		_ = json.Unmarshal(body, &v)
		f.mu.Lock()
		f.created = v
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"Id":"c1","Warnings":[]}`)
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/containers/c1/json"):
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, f.inspect)
	case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/app:1/json") && f.image != "":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, f.image)
	default:
		http.NotFound(w, r)
	}
}

func newFakeMoby(t *testing.T, f *fakeDaemon) *Moby {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	cli, err := client.New(client.WithHost("tcp://"+strings.TrimPrefix(srv.URL, "http://")), client.WithAPIVersion("1.52"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return &Moby{cli: cli, driver: "cgroupfs"}
}

// portBindings is HostConfig.PortBindings of the last create, as JSON values.
func (f *fakeDaemon) portBindings(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	host, _ := f.created["HostConfig"].(map[string]any)
	pb, _ := host["PortBindings"].(map[string]any)
	if pb == nil {
		t.Fatalf("no PortBindings in %v", f.created)
	}
	return pb
}

func TestCreateContainerPublishesOnHostIP(t *testing.T) {
	f := &fakeDaemon{}
	m := newFakeMoby(t, f)
	_, err := m.CreateContainer(context.Background(), ContainerSpec{Name: "seylo-panel00000000000-2", Image: "seylo:1", Publish: []PortPublish{
		{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 3000, ContainerPort: 3000},
		{HostPort: 3443, ContainerPort: 3443},
	}})
	if err != nil {
		t.Fatal(err)
	}
	pb := f.portBindings(t)
	want := map[string]string{
		// The panel port on loopback only.
		"3000/tcp": `[{"HostIp":"127.0.0.1","HostPort":"3000"}]`,
		// A zero HostIP is sent as "", which Docker reads as every address:
		// what 0.2.0 sent for every port.
		"3443/tcp": `[{"HostIp":"","HostPort":"3443"}]`,
	}
	for port, w := range want {
		got, _ := json.Marshal(pb[port])
		if string(got) != w {
			t.Errorf("%s = %s, want %s", port, got, w)
		}
	}
	if len(pb) != len(want) {
		t.Errorf("bindings = %v", pb)
	}
}

// Two host ports for one container port are both published (they used to
// overwrite each other).
func TestCreateContainerKeepsEveryBindingOfAPort(t *testing.T) {
	f := &fakeDaemon{}
	m := newFakeMoby(t, f)
	_, err := m.CreateContainer(context.Background(), ContainerSpec{Name: "x", Image: "seylo:1", Publish: []PortPublish{
		{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 3000, ContainerPort: 3000},
		{HostIP: netip.MustParseAddr("::1"), HostPort: 3000, ContainerPort: 3000},
	}})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(f.portBindings(t)["3000/tcp"])
	if string(got) != `[{"HostIp":"127.0.0.1","HostPort":"3000"},{"HostIp":"::1","HostPort":"3000"}]` {
		t.Fatalf("3000/tcp = %s", got)
	}
}

func TestCreateContainerRefusesBadPublish(t *testing.T) {
	m := newFakeMoby(t, &fakeDaemon{})
	for _, p := range []PortPublish{
		{HostPort: 0, ContainerPort: 3000},
		{HostPort: 70000, ContainerPort: 3000},
		{HostIP: netip.MustParseAddr("fe80::1%eth0"), HostPort: 3000, ContainerPort: 3000},
	} {
		if _, err := m.CreateContainer(context.Background(), ContainerSpec{Name: "x", Image: "seylo:1", Publish: []PortPublish{p}}); err == nil {
			t.Errorf("%+v was accepted", p)
		}
	}
}

// InspectContainer reports the TCP bindings the container was created
// with, with their host address, whatever its state.
func TestInspectContainerReportsBindings(t *testing.T) {
	f := &fakeDaemon{inspect: `{"Id":"c1","Name":"/seylo-panel00000000000-1","State":{"Status":"exited","Running":false},
		"Config":{"Image":"seylo:1","Labels":{}},
		"HostConfig":{"PortBindings":{
			"3443/tcp":[{"HostIp":"","HostPort":"3443"}],
			"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3000"}],
			"53/udp":[{"HostIp":"","HostPort":"53"}],
			"8080/tcp":[{"HostIp":"","HostPort":""}]}}}`}
	m := newFakeMoby(t, f)
	d, err := m.InspectContainer(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	want := []PortPublish{
		{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: 3000, ContainerPort: 3000},
		{HostPort: 3443, ContainerPort: 3443},
	}
	if !slices.Equal(d.Publish, want) {
		t.Fatalf("publish = %v, want %v", d.Publish, want)
	}
	if d.Publish[0].Host() != "127.0.0.1:3000" || d.Publish[1].Host() != "0.0.0.0:3443" {
		t.Fatalf("hosts = %s, %s", d.Publish[0].Host(), d.Publish[1].Host())
	}
}

// InspectContainer reports Docker's own health status with the output and
// exit code of the latest check, and none for a container Docker does not
// check.
func TestInspectContainerReportsDockerHealth(t *testing.T) {
	f := &fakeDaemon{inspect: `{"Id":"c1","Name":"/web","State":{"Status":"running","Running":true,
		"Health":{"Status":"unhealthy","FailingStreak":3,"Log":[
			{"Start":"2026-11-12T10:00:00Z","End":"2026-11-12T10:00:01Z","ExitCode":1,"Output":"older"},
			{"Start":"2026-11-12T10:00:10Z","End":"2026-11-12T10:00:11Z","ExitCode":7,"Output":"curl: (7) connection refused"}]}},
		"Config":{"Image":"app:1","Labels":{}}}`}
	m := newFakeMoby(t, f)
	d, err := m.InspectContainer(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	want := ContainerHealth{Status: HealthUnhealthy, FailingStreak: 3, Output: "curl: (7) connection refused", ExitCode: 7}
	if d.Health == nil || *d.Health != want {
		t.Fatalf("health = %+v, want %+v", d.Health, want)
	}

	for _, state := range []string{`{"Status":"running","Running":true}`, `{"Status":"running","Running":true,"Health":{"Status":"none"}}`} {
		f.inspect = `{"Id":"c1","Name":"/web","State":` + state + `,"Config":{"Image":"app:1"}}`
		d, err := m.InspectContainer(context.Background(), "c1")
		if err != nil {
			t.Fatal(err)
		}
		if d.Health != nil {
			t.Errorf("%s: health = %+v, want none", state, d.Health)
		}
	}
}

// InspectImage reports the image's HEALTHCHECK as Docker stores it.
func TestInspectImageReportsHealthcheck(t *testing.T) {
	f := &fakeDaemon{image: `{"Id":"sha256:1","Config":{"Healthcheck":{"Test":["CMD-SHELL","curl -fs localhost/healthz"],
		"Interval":10000000000,"Timeout":3000000000,"StartPeriod":600000000000,"Retries":5}}}`}
	m := newFakeMoby(t, f)
	img, err := m.InspectImage(context.Background(), "app:1")
	if err != nil {
		t.Fatal(err)
	}
	hc := img.Healthcheck
	if hc == nil || !slices.Equal(hc.Test, []string{"CMD-SHELL", "curl -fs localhost/healthz"}) ||
		hc.Interval != 10*time.Second || hc.Timeout != 3*time.Second || hc.StartPeriod != 10*time.Minute || hc.Retries != 5 {
		t.Fatalf("healthcheck = %+v", hc)
	}

	f.image = `{"Id":"sha256:2","Config":{"Entrypoint":["/init"],"Cmd":["sh"]}}`
	img, err = m.InspectImage(context.Background(), "app:1")
	if err != nil {
		t.Fatal(err)
	}
	if img.Healthcheck != nil {
		t.Fatalf("healthcheck = %+v, want none", img.Healthcheck)
	}
	// What InitFor reads.
	if !slices.Equal(img.Entrypoint, []string{"/init"}) || !slices.Equal(img.Cmd, []string{"sh"}) {
		t.Fatalf("entrypoint %v, cmd %v", img.Entrypoint, img.Cmd)
	}
}
