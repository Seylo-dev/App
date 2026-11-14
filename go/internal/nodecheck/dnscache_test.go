package nodecheck

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dnscache"
)

// A container created with the DNS cache first keeps working in the
// Container DNS check's eyes: the cache's link-local address is a usable
// server, not an unknown one, on a project network (ExtServers) and on
// the default bridge.
func TestContainerDNSCountsTheCache(t *testing.T) {
	for _, file := range []string{
		projectResolvConf("[169.254.53.53 8.8.8.8 1.1.1.1]", true),
		overrideResolvConf("169.254.53.53", "8.8.8.8", "1.1.1.1"),
	} {
		rc := parseResolvConf(file)
		if works, known := rc.lookupsWork(); !works || !known {
			t.Errorf("lookupsWork = %v, %v for\n%s", works, known, file)
		}
		if v := judgeServers(rc.settingServers(), false); v != dnsOK {
			t.Errorf("judgeServers = %v, want dnsOK for\n%s", v, file)
		}
		if (ownContainer{RC: rc}).stale() {
			t.Errorf("a container with the cache counts as stale:\n%s", file)
		}
	}
}

func passingReport(users int) *dnscache.Report {
	return &dnscache.Report{
		Enabled: true, Address: dnscache.DefaultAddress, Users: users, Upstreams: []string{"8.8.8.8", "1.1.1.1"},
		HostName: "panel.example.com",
		Runs: []dnscache.ProbeRun{
			{Network: "bridge", Name: "probe-1." + dnscache.ProbeZone, Output: "Address: 192.0.2.53"},
			{Network: "seylo-p-0123456789abcdef", Name: "probe-2." + dnscache.ProbeZone, Output: "Address: 192.0.2.53"},
		},
		Passes: []bool{true, true},
	}
}

func TestJudgeDNSCache(t *testing.T) {
	ufw := "ufw allow to 169.254.53.53 port 53"
	for _, tc := range []struct {
		name   string
		report func() *dnscache.Report
		status agentv1.NodeCheckStatus
		detail []string
		hint   string
	}{
		{"off", func() *dnscache.Report { return nil }, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED, []string{"off"}, ""},
		{"passes", func() *dnscache.Report { return passingReport(3) }, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS,
			[]string{"bridge and seylo-p-0123456789abcdef", "169.254.53.53", "panel.example.com", "8.8.8.8, 1.1.1.1", "3 running containers use it", "repeated lookups", "no hard limit"}, ""},
		{"firewall drops the project network", func() *dnscache.Report {
			r := passingReport(2)
			r.Runs[1].Err, r.Runs[1].Output = "exit status 1", ";; connection timed out; no servers could be reached"
			r.Passes[1] = false
			return r
		}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL,
			[]string{"a test container on seylo-p-0123456789abcdef gets no answer", "connection timed out", "2 running containers already use it", "about 4 seconds"}, ufw},
		{"no upstream", func() *dnscache.Report {
			r := passingReport(0)
			r.HostErr = "panel.example.com: the cache answered RCodeServerFailure"
			return r
		}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, []string{"gets no answer from its upstream servers (8.8.8.8, 1.1.1.1)"}, "dig @"},
		{"port taken", func() *dnscache.Report {
			return &dnscache.Report{Enabled: true, Address: dnscache.DefaultAddress, Blocked: "dnsmasq holds port 53 on every address", Hint: "Make that program listen"}
		}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_FAIL, []string{"cannot run on this node: dnsmasq holds port 53", "keep Docker's own DNS servers"}, "Make that program listen"},
		{"no test image", func() *dnscache.Report {
			r := passingReport(0)
			r.Runs, r.Passes, r.Skipped = nil, nil, "no moby/buildkit, traefik, alpine or busybox image on this node, and the test pulls none"
			return r
		}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_WARN, []string{"no test container could run"}, "docker pull busybox"},
		{"draining", func() *dnscache.Report {
			r := passingReport(1)
			r.Enabled = false
			return r
		}, agentv1.NodeCheckStatus_NODE_CHECK_STATUS_PASS, []string{"off; 1 running container still uses it", "until it is redeployed"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := &Env{DNSCache: func(context.Context) *dnscache.Report { return tc.report() }}
			r := env.dnsCache(context.Background())
			if r.GetStatus() != tc.status {
				t.Fatalf("status %s: %s", r.GetStatus(), r.GetDetail())
			}
			for _, want := range tc.detail {
				if !strings.Contains(r.GetDetail(), want) {
					t.Errorf("detail lacks %q:\n%s", want, r.GetDetail())
				}
			}
			if !strings.Contains(r.GetFixHint(), tc.hint) {
				t.Errorf("hint lacks %q:\n%s", tc.hint, r.GetFixHint())
			}
		})
	}
	// The CLI runs without the agent.
	if r := (&Env{}).dnsCache(context.Background()); r.GetStatus() != agentv1.NodeCheckStatus_NODE_CHECK_STATUS_SKIPPED {
		t.Fatalf("without the agent: %s", r.GetStatus())
	}
}

// The test containers: busybox nslookup against the cache's address, from
// an image already on the node, on the default bridge and on the first
// project network; an image without nslookup is passed over.
func TestProbeDNSCacheCommands(t *testing.T) {
	var cmds []string
	env := Env{
		Docker: fakeDocker{info: &DockerInfo{}},
		Run: func(_ context.Context, w io.Writer, name string, args ...string) error {
			line := strings.Join(append([]string{name}, args...), " ")
			cmds = append(cmds, line)
			switch {
			case strings.Contains(line, "docker image ls"):
				_, _ = io.WriteString(w, "traefik:v3.7.15\nmoby/buildkit:buildx-stable-1\nnginx:1\n")
			case strings.Contains(line, "docker network ls"):
				_, _ = io.WriteString(w, "seylo-edge\nseylo-p-ffff000000000000\nseylo-p-0123456789abcdef\n")
			case strings.Contains(line, "docker run") && strings.Contains(line, "moby/buildkit"):
				return errors.New(`docker run: exit status 127: exec: "nslookup": executable file not found in $PATH`)
			case strings.Contains(line, "docker run"):
				f := strings.Fields(line)
				_, _ = fmt.Fprintf(w, "Server:\t\t%s\nName:\t%s\nAddress: %s\n", f[len(f)-1], f[len(f)-2], dnscache.ProbeAnswer)
				// busybox exits 1: the AAAA question had no answer.
				return errors.New("docker run: exit status 1: ")
			}
			return nil
		},
	}
	runs, skipped := ProbeDNSCache(env)(context.Background(), dnscache.DefaultAddress, dnscache.ProbeZone)
	if skipped != "" || len(runs) != 2 {
		t.Fatalf("runs %+v skipped %q", runs, skipped)
	}
	if runs[0].Network != "bridge" || runs[1].Network != "seylo-p-0123456789abcdef" {
		t.Fatalf("networks %q, %q", runs[0].Network, runs[1].Network)
	}
	for _, r := range runs {
		if r.Err != "" || !strings.Contains(r.Output, "192.0.2.53") || r.Image != "traefik:v3.7.15" || !strings.HasSuffix(r.Name, strings.TrimSuffix(dnscache.ProbeZone, ".")) {
			t.Fatalf("run %+v", r)
		}
	}
	var run []string
	for _, c := range cmds {
		if strings.Contains(c, "docker run") {
			run = append(run, c)
		}
	}
	want := "--pull never --network bridge --label seylo.dnscheck=true --label traefik.enable=false --entrypoint nslookup moby/buildkit:buildx-stable-1 probe-"
	if !strings.Contains(run[0], want) || !strings.HasSuffix(run[0], " 169.254.53.53") {
		t.Fatalf("first run %q", run[0])
	}
	if !slices.ContainsFunc(cmds, func(c string) bool { return strings.Contains(c, "DOCKER_CONFIG=") }) {
		t.Fatal("not run with the builds' DOCKER_CONFIG")
	}

	// No image to run.
	env.Run = func(_ context.Context, w io.Writer, name string, args ...string) error {
		_, _ = io.WriteString(w, "nginx:1\n")
		return nil
	}
	if runs, skipped := ProbeDNSCache(env)(context.Background(), dnscache.DefaultAddress, dnscache.ProbeZone); len(runs) != 0 || !strings.Contains(skipped, "pulls none") {
		t.Fatalf("no image: %+v %q", runs, skipped)
	}
}

func TestProbeImages(t *testing.T) {
	got := probeImages("busybox:latest\ndocker.io/library/alpine:3.20\nnginx:1\n<none>:<none>\ntraefik:v3.7.15\n")
	if want := []string{"traefik:v3.7.15", "docker.io/library/alpine:3.20", "busybox:latest"}; !slices.Equal(got, want) {
		t.Fatalf("images %q, want %q", got, want)
	}
}
