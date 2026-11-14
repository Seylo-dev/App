//go:build integration

package jobrun_test

import (
	"bytes"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
	"github.com/seylo-dev/app/go/internal/jobrun/itest"
)

// Cron runs and helpers get the node's DNS cache like service containers:
// the servers Docker writes for the embedded DNS (ExtServers), and the
// label, without changing the caller's label map. A zero value keeps
// Docker's own servers.
func TestRunGetsTheDNSCache(t *testing.T) {
	e := itest.New(t)
	ctx := e.Ctx(5 * time.Minute)
	cache := netip.MustParseAddr("169.254.53.53")
	e.D.DNS = func() docker.ContainerDNS {
		return docker.ContainerDNS{Servers: []netip.Addr{cache, netip.MustParseAddr("192.0.2.1")}, Cache: cache}
	}
	defer func() { e.D.DNS = nil }()
	s := spec(e, e.Project+"-dns", "cat /etc/resolv.conf")
	var out bytes.Buffer
	if _, err := e.D.Run(ctx, s, jobrun.IO{Stdout: &out}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "ExtServers: [169.254.53.53 192.0.2.1]") {
		t.Fatalf("resolv.conf of a run with the cache:\n%s", out.String())
	}
	if _, ok := s.Labels[docker.LabelDNSCache]; ok {
		t.Fatal("the caller's labels were changed")
	}

	e.D.DNS = func() docker.ContainerDNS { return docker.ContainerDNS{} }
	out.Reset()
	if _, err := e.D.Run(ctx, spec(e, e.Project+"-nodns", "cat /etc/resolv.conf"), jobrun.IO{Stdout: &out}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "169.254.53.53") {
		t.Fatalf("resolv.conf without the cache:\n%s", out.String())
	}
}
