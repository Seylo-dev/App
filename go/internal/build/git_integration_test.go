//go:build integration

package build

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestFetchGitOverSSH clones from an sshd container with a deploy key and
// pinned host keys, and refuses a host whose key is not pinned.
func TestFetchGitOverSSH(t *testing.T) {
	if os.Getenv("SEYLO_IT") != "1" {
		t.Skip("integration tests run in the test VM (SEYLO_IT=1)")
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	name := "bdit-" + hex.EncodeToString(b[:]) + "-sshd"
	dir := t.TempDir()
	key := filepath.Join(dir, "id")
	if out, err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).CombinedOutput(); err != nil {
		t.Fatalf("ssh-keygen: %v %s", err, out)
	}
	pub, _ := os.ReadFile(key + ".pub")
	script := `set -e
apk add --no-cache openssh-server git >/dev/null
ssh-keygen -A >/dev/null
adduser -D -s /usr/bin/git-shell git && passwd -u git >/dev/null 2>&1 || true
mkdir -p /home/git/.ssh && echo "$PUB" > /home/git/.ssh/authorized_keys
chown -R git /home/git && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys
mkdir /tmp/w && cd /tmp/w && git init -q -b main && echo ssh-ok > a.txt && git add . && git -c user.name=T -c user.email=t@e commit -qm "over ssh"
git clone -q --bare /tmp/w /home/git/repo.git && chown -R git /home/git/repo.git
touch /ready
exec /usr/sbin/sshd -D -e`
	run := func(args ...string) string {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("run", "-d", "--name", name, "--label", "bdit="+name, "-e", "PUB="+strings.TrimSpace(string(pub)), "alpine:3.22", "sh", "-c", script)
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	ip := run("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name)

	var hosts []byte
	for i := 0; ; i++ {
		if exec.Command("docker", "exec", name, "test", "-f", "/ready").Run() == nil {
			hosts, _ = exec.Command("ssh-keyscan", "-t", "ed25519", ip).Output()
			if len(hosts) > 0 {
				break
			}
		}
		if i > 120 {
			logs, _ := exec.Command("docker", "logs", name).CombinedOutput()
			t.Fatalf("sshd never came up:\n%s", logs)
		}
		time.Sleep(time.Second)
	}
	privKey, _ := os.ReadFile(key)
	url := "git@" + ip + ":repo.git"

	work := t.TempDir()
	var log bytes.Buffer
	src := &agentv1.GitSource{Url: url, SshPrivateKey: string(privKey), SshKnownHosts: string(hosts)}
	if err := validateGit(src); err != nil {
		t.Fatal(err)
	}
	info, err := fetchGit(context.Background(), ExecRunner{}, &log, src, filepath.Join(work, "src"), work, false)
	if err != nil {
		t.Fatalf("%v\n%s", err, log.String())
	}
	if got, _ := os.ReadFile(filepath.Join(work, "src", "a.txt")); string(got) != "ssh-ok\n" || info.GetSubject() != "over ssh" {
		t.Fatalf("checkout %q, info %v", got, info)
	}

	// Without the host's key (built-in hosts only) the clone is refused.
	work2 := t.TempDir()
	log.Reset()
	_, err = fetchGit(context.Background(), ExecRunner{}, &log, &agentv1.GitSource{Url: url, SshPrivateKey: string(privKey)}, filepath.Join(work2, "src"), work2, false)
	if !errors.Is(err, ErrFetch) || !strings.Contains(log.String(), "Host key verification failed") {
		t.Fatalf("unpinned host: %v\n%s", err, log.String())
	}
}
