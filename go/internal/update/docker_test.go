package update

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func mustMarshal(m proto.Message) []byte {
	b, err := proto.Marshal(m)
	if err != nil {
		panic(err)
	}
	return b
}

const aptPolicy = `docker-ce:
  Installed: 5:27.3.1-1~ubuntu.24.04~noble
  Candidate: 5:28.0.1-1~ubuntu.24.04~noble
  Version table:
     5:28.0.1-1~ubuntu.24.04~noble 500
        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages
 *** 5:27.3.1-1~ubuntu.24.04~noble 100
        100 /var/lib/dpkg/status
`

func TestParsers(t *testing.T) {
	installed, candidate := parseAptPolicy(aptPolicy)
	if packageVersion(installed) != "27.3.1" || packageVersion(candidate) != "28.0.1" {
		t.Fatalf("apt = %q %q", installed, candidate)
	}
	if i, c := parseAptPolicy("docker.io:\n  Installed: (none)\n  Candidate: 27.5.1-0ubuntu3~24.04.2\n"); i != "" || packageVersion(c) != "27.5.1" {
		t.Fatalf("apt none = %q %q", i, c)
	}
	dnf := "Available Upgrades\ndocker-ce.x86_64    3:28.0.1-1.el9    docker-ce-stable\n"
	if v := packageVersion(parseRPMUpgrade(dnf, "docker-ce")); v != "28.0.1" {
		t.Fatalf("dnf = %q", v)
	}
	if v := parseRPMUpgrade("", "docker-ce"); v != "" {
		t.Fatalf("empty dnf = %q", v)
	}
}

// scripted answers commands from a table and records them. "!fail" fails
// the command; "!block" waits until its context ends (a slow apt-get).
type scripted struct {
	mu      sync.Mutex
	answers map[string]string
	calls   []string
}

func (s *scripted) run(ctx context.Context, w io.Writer, name string, args ...string) error {
	cmd := strings.TrimSpace(name + " " + strings.Join(args, " "))
	s.mu.Lock()
	s.calls = append(s.calls, cmd)
	best := ""
	for prefix := range s.answers {
		if strings.HasPrefix(cmd, prefix) && len(prefix) > len(best) {
			best = prefix
		}
	}
	out := s.answers[best]
	s.mu.Unlock()
	switch {
	case best == "":
		return fmt.Errorf("unexpected command %q", cmd)
	case out == "!fail":
		return fmt.Errorf("%s: exit status 1", cmd)
	case out == "!block":
		<-ctx.Done()
		return fmt.Errorf("%s: %w", cmd, ctx.Err())
	}
	_, _ = io.WriteString(w, out)
	return nil
}

// set changes one answer.
func (s *scripted) set(prefix, out string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answers[prefix] = out
}

// ran returns the commands so far.
func (s *scripted) ran() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

// count is how many commands so far start with prefix.
func (s *scripted) count(prefix string) int {
	n := 0
	for _, c := range s.ran() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func TestDockerUpdateApt(t *testing.T) {
	sc := &scripted{answers: map[string]string{
		"dpkg-query -W -f=${Status} docker-ce":     "install ok installed",
		"dpkg-query -W -f=${Status} containerd.io": "install ok installed",
		"dpkg-query":                 "!fail",
		"apt-get update":             "",
		"apt-cache policy docker-ce": aptPolicy,
		"env DEBIAN_FRONTEND":        "",
		"docker version":             "28.0.1\n",
	}}
	rep := &reports{}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, Report: rep.add, LookPath: func(n string) bool { return n == "apt-get" || n == "dpkg-query" }}, &Lock{})

	res, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true})
	if err != nil || res.GetFromVersion() != "27.3.1" || res.GetToVersion() != "28.0.1" || res.GetWarning() != "" {
		t.Fatalf("dry run = %v, %v", res, err)
	}
	// With live-restore off the answer warns that services stop.
	d.opts.LiveRestore = func(context.Context) (bool, error) { return false, nil }
	if res, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true}); err != nil || !strings.Contains(res.GetWarning(), "live-restore is off") {
		t.Fatalf("dry run without live-restore = %v, %v", res, err)
	}
	d.opts.LiveRestore = func(context.Context) (bool, error) { return true, nil }
	if res, _ := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true}); res.GetWarning() != "" {
		t.Fatalf("warning with live-restore on: %v", res)
	}
	for _, c := range sc.ran() {
		if strings.HasPrefix(c, "env ") {
			t.Fatal("dry run upgraded")
		}
	}

	if _, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{UpdateId: "d1"}); err != nil {
		t.Fatal(err)
	}
	r := waitReport(t, rep)
	if !r.GetSuccess() || r.GetTarget() != agentv1.UpdateTarget_UPDATE_TARGET_DOCKER || r.GetUpdateId() != "d1" {
		t.Fatalf("result = %v", r)
	}
	var upgrade string
	for _, c := range sc.ran() {
		if strings.HasPrefix(c, "env ") {
			upgrade = c
		}
	}
	if !strings.Contains(upgrade, "--only-upgrade") || !strings.HasSuffix(upgrade, "docker-ce docker-ce-cli containerd.io") {
		t.Fatalf("upgrade command = %q", upgrade)
	}
}

func TestDockerUpdateNotFromPackages(t *testing.T) {
	sc := &scripted{answers: map[string]string{"dpkg-query": "!fail"}}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: func(n string) bool { return n == "apt-get" || n == "dpkg-query" }}, &Lock{})
	_, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true})
	if err == nil || !strings.Contains(err.Error(), "not installed with the package manager") {
		t.Fatalf("err = %v", err)
	}
}

func TestDockerUpdateHeld(t *testing.T) {
	sc := &scripted{answers: map[string]string{
		"dpkg-query -W -f=${Status} docker-ce": "hold ok installed",
		"dpkg-query":                           "!fail",
		"apt-get update":                       "",
		"apt-cache policy docker-ce":           aptPolicy,
	}}
	d := NewDockerUpdater(DockerOptions{Run: sc.run, LookPath: func(n string) bool { return n == "apt-get" || n == "dpkg-query" }}, &Lock{})
	if res, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{DryRun: true}); err != nil || res.GetToVersion() != "28.0.1" {
		t.Fatalf("dry run = %v, %v", res, err)
	}
	if _, err := d.Update(context.Background(), &agentv1.UpdateDockerRequest{}); err == nil || !strings.Contains(err.Error(), "apt-mark unhold docker-ce") {
		t.Fatalf("held upgrade: %v", err)
	}
}
