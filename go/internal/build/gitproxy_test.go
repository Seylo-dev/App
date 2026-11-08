package build

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestGitTargetAndPolicy(t *testing.T) {
	for raw, want := range map[string]string{
		"https://Git.Example.com/a.git":       "git.example.com:443",
		"https://git.example.com.:8443/a.git": "git.example.com:8443",
		"http://10.0.0.7/a.git":               "10.0.0.7:80",
		"ssh://git@[FD00::1]:2222/a.git":      "[fd00::1]:2222",
		"ssh://git@gitea.lan/a.git":           "gitea.lan:22",
		"git@gitea.lan:team/a.git":            "gitea.lan:22",
	} {
		got, err := gitTargetOf(raw)
		if err != nil || got.String() != want {
			t.Errorf("gitTargetOf(%q) = %v %v, want %s", raw, got, err, want)
		}
	}

	p, err := gitPolicyFor(&agentv1.GitSource{Url: "https://Gitea.lan:3000/a.git", AllowInternalHost: true}, GitNodeConfig{})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		host, port string
		want       bool
	}{
		{"gitea.lan", "3000", true},
		{"GITEA.LAN.", "3000", true},
		{"gitea.lan", "443", false},
		{"other.lan", "3000", false},
		{"127.0.0.1", "3000", false},
	} {
		if got := p.internalAllowed(c.host, c.port); got != c.want {
			t.Errorf("internalAllowed(%s, %s) = %v", c.host, c.port, got)
		}
	}
	v6, _ := gitPolicyFor(&agentv1.GitSource{Url: "ssh://git@[fd00:0::1]:22/a.git", SshPrivateKey: "k", AllowInternalHost: true}, GitNodeConfig{})
	if !v6.internalAllowed("fd00::1", "22") || !v6.internalAllowed("[FD00::0001]", "22") {
		t.Error("an IPv6 host in another spelling is the same host")
	}
	off, _ := gitPolicyFor(&agentv1.GitSource{Url: "https://gitea.lan:3000/a.git"}, GitNodeConfig{})
	if off.internalAllowed("gitea.lan", "3000") {
		t.Error("internal addresses without allow_internal_host")
	}
}

// echoServer answers every connection with what it reads.
func echoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

// The ssh ProxyCommand runs the agent binary (here the test binary, see
// TestMain) through a shell, the way ssh does, and gets a tunnel only to
// an address the fetch's policy allows.
func TestGitDialProxyCommand(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	target := echoServer(t)
	host, port, _ := net.SplitHostPort(target)
	run := func(allow bool) (string, string, error) {
		var log bytes.Buffer
		p, err := startGitProxy(gitPolicy{source: gitTarget{host: host, port: port}, allowInternal: allow}, &log)
		if err != nil {
			t.Fatal(err)
		}
		cmd, err := gitDialProxyCommand(p.Addr(), target)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		c := exec.CommandContext(ctx, sh, "-c", "exec "+cmd)
		stdin, _ := c.StdinPipe()
		stdout, _ := c.StdoutPipe()
		var errOut bytes.Buffer
		c.Stderr = &errOut
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		_, _ = stdin.Write([]byte("ping\n"))
		// The echo comes back (or nothing, when refused); closing stdin ends the tunnel.
		buf := make([]byte, 5)
		n, _ := io.ReadFull(stdout, buf)
		_ = stdin.Close()
		_, _ = io.Copy(io.Discard, stdout)
		err = c.Wait()
		p.Close()
		return string(buf[:n]), errOut.String() + log.String(), err
	}
	out, logs, err := run(true)
	if err != nil || out != "ping\n" {
		t.Fatalf("allowed: %q %v\n%s", out, err, logs)
	}
	out, logs, err = run(false)
	if err == nil || out != "" || !strings.Contains(logs, "loopback") {
		t.Fatalf("refused: out %q err %v\n%s", out, err, logs)
	}
}

func TestGitDialNeedsALoopbackProxy(t *testing.T) {
	err := GitDial(context.Background(), "203.0.113.9:8080", "github.com:22", strings.NewReader(""), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("got %v", err)
	}
}

func TestGitUsesTheFetchProxy(t *testing.T) {
	g, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "ssh://git@gitea.lan:2222/a.git", SshPrivateKey: "k", SshKnownHosts: "[gitea.lan]:2222 ssh-ed25519 AAAA"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer g.close()
	args := strings.Join(g.args, " ")
	if !strings.Contains(args, "http.proxy=http://127.0.0.1:") || !strings.Contains(args, "protocol.ssh.allow=always") {
		t.Fatalf("args %q", args)
	}
	for _, e := range proxyEnv {
		if !slices.Contains(g.env, e) {
			t.Errorf("env lacks %s", e)
		}
	}
	var sshCmd string
	for _, e := range g.env {
		if v, ok := strings.CutPrefix(e, "GIT_SSH_COMMAND="); ok {
			sshCmd = v
		}
	}
	// The target is fixed, never ssh's %h.
	if !strings.Contains(sshCmd, "ProxyCommand=") || !strings.Contains(sshCmd, " "+GitDialCommand+" ") ||
		!strings.Contains(sshCmd, "gitea.lan:2222") || strings.Contains(sshCmd, "%h") {
		t.Fatalf("GIT_SSH_COMMAND %q", sshCmd)
	}

	https, err := newGit(ExecRunner{}, &bytes.Buffer{}, &agentv1.GitSource{Url: "https://github.com/a/b.git"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer https.close()
	if !slices.Contains(https.args, "protocol.ssh.allow=never") {
		t.Fatalf("ssh without a key: %q", https.args)
	}
	for _, e := range https.env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			t.Fatalf("GIT_SSH_COMMAND without a key: %q", e)
		}
	}
}

func TestSSHHostIsValidated(t *testing.T) {
	for _, bad := range []string{"ssh://git@a;b/x.git", "ssh://git@a$(id)/x.git", "ssh://git@-oProxy/x.git"} {
		if err := validateGit(&agentv1.GitSource{Url: bad, SshPrivateKey: "k"}); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	for _, good := range []string{"ssh://git@gitea.lan:2222/x.git", "ssh://git@[fd00::1]/x.git", "ssh://git@10.0.0.7/x.git"} {
		if err := validateGit(&agentv1.GitSource{Url: good, SshPrivateKey: "k"}); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
}

func TestBlockedHostErrorIsAFetchError(t *testing.T) {
	err := error(&BlockedHostError{Target: "gitea.lan:443", Reason: "gitea.lan resolves to 10.0.0.7, a private address"})
	if !errors.Is(err, ErrFetch) || !errors.Is(err, ErrBlockedHost) || !strings.Contains(err.Error(), "10.0.0.7") {
		t.Fatalf("%v", err)
	}
}
