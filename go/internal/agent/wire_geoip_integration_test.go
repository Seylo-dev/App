//go:build integration

package agent

// The check from Traefik's container against real Docker in the test VM:
// busybox wget in the Traefik image reaches the lookup server on the edge
// bridge's gateway, and a host firewall that drops the port on that bridge
// (what ufw does without the 5758 rule) is seen, although the agent's own
// check over loopback still answers.
//
//	scripts/dev/vm-gotest.sh ./internal/agent -run IntegrationGeoIPProbe -v

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/geoip"
	"github.com/seylo-dev/app/go/internal/proxy"
)

func TestIntegrationGeoIPProbeFromTraefik(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration test: run with scripts/dev/vm-gotest.sh")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	network, bridge, name := "seylo-it-geo-"+id, "sitg"+id, "seylo-it-geo-"+id+"-traefik"
	sh := func(args ...string) string {
		t.Helper()
		out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	sh("docker", "network", "create", "--opt", docker.BridgeNameOption+"="+bridge, network)
	t.Cleanup(func() { _ = exec.Command("docker", "network", "rm", network).Run() })
	gw := sh("docker", "network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", network)
	sh("docker", "run", "-d", "--name", name, "--network", network, "--entrypoint", "sleep", proxy.TraefikImage, "600")
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })

	l, err := net.Listen("tcp", net.JoinHostPort(gw, "0"))
	if err != nil {
		t.Fatal(err)
	}
	listen := l.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = (&geoip.Server{Path: filepath.Join(t.TempDir(), "none.mmdb")}).Serve(ctx, l) }()

	eng, err := docker.NewMoby("")
	if err != nil {
		t.Fatal(err)
	}
	p := &networkParts{traefik: proxy.TraefikConfig{Name: name}}
	reach := p.traefikReaches(eng)
	if err := reach(ctx, listen); err != nil {
		t.Fatalf("Traefik's container does not reach %s: %v", listen, err)
	}

	port := strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
	rule := []string{"INPUT", "-i", bridge, "-p", "tcp", "--dport", port, "-j", "DROP"}
	sh(append([]string{"iptables", "-I"}, rule...)...)
	t.Cleanup(func() { _ = exec.Command("iptables", append([]string{"-D"}, rule...)...).Run() })
	start := time.Now()
	err = reach(ctx, listen)
	if err == nil || errors.Is(err, errProbeUnavailable) {
		t.Fatalf("a firewall on the bridge: %v", err)
	}
	t.Logf("seen in %s: %v", time.Since(start).Round(time.Millisecond), err)

	// No such container: the check cannot run, the agent's own decides.
	p.traefik.Name = "seylo-it-geo-" + id + "-missing"
	if err := p.traefikReaches(eng)(ctx, listen); !errors.Is(err, errProbeUnavailable) {
		t.Errorf("a missing container: %v", err)
	}
}
