//go:build !windows

package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/datadir"
)

const rotateScriptOutput = "New master.key written; 8 sealed values sealed again:\n" +
	"  sudo seylo join 'https://203.0.113.7:3443' --token '<token>' --pin 'sha256:new' --force\n"

// rotateFixture is a panel node with fakes for Docker, systemd and the
// panel's health endpoint.
type rotateFixture struct {
	h        *harness
	panelDir string
	health   *httptest.Server
	// status is what /api/health answers (200 by default).
	status   atomic.Int32
	healthOK atomic.Int32
	// script answers `docker run` (the rotation script): its output and error.
	script func(ctx context.Context) (string, error)
	runs   int
	// imageVersion is the panel image's org.opencontainers.image.version label.
	imageVersion string
}

func newRotateFixture(t *testing.T) *rotateFixture {
	t.Helper()
	f := &rotateFixture{h: newHarness(t), imageVersion: "0.2.0-rc.2"}
	f.h.euid = 0
	f.status.Store(http.StatusOK)
	f.health = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(int(f.status.Load()))
		if f.status.Load() == http.StatusOK {
			f.healthOK.Add(1)
		}
	}))
	t.Cleanup(f.health.Close)
	f.panelDir = filepath.Join(f.h.dataDir, "panel")
	if err := os.MkdirAll(f.panelDir, 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"master.key", "panel.db"} {
		if err := os.WriteFile(filepath.Join(f.panelDir, name), []byte("x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f.script = func(context.Context) (string, error) { return rotateScriptOutput, nil }
	f.h.units.log = &f.h.cmds
	u, _ := url.Parse(f.health.URL)
	f.h.answer = func(cmd string) (string, error) {
		switch {
		case strings.HasPrefix(cmd, "docker ps --all"):
			return "c1\nc0\nui1", nil
		case strings.HasPrefix(cmd, "docker container inspect --format {{.Id}}"):
			// The running generation 2 (on the health server's port), the old
			// generation 1, and a role container that is not the panel.
			return fmt.Sprintf("c1\ttrue\t2026-11-08T00:49:51.5Z\tsha256:img2\t{\"seylo.service\":\"panel00000000000\"}\t[\"SEYLO_PORT=3000\",\"SEYLO_HOST_PORT=%s\"]\n"+
				"c0\tfalse\t2026-11-01T10:00:00Z\tsha256:img1\tnull\t[\"SEYLO_HOST_PORT=3000\"]\n"+
				"ui1\ttrue\t2026-11-09T00:00:00Z\tsha256:ui\t{\"seylo.role\":\"db-ui\"}\t[]", u.Port()), nil
		case strings.HasPrefix(cmd, "docker container inspect --format {{.State.Running}} seylo-rotate-key"):
			return "", errors.New("Error: No such object: seylo-rotate-key")
		case cmd == "docker image inspect --format {{json .Config.Labels}} sha256:img2":
			return fmt.Sprintf(`{"org.opencontainers.image.title":"panel","org.opencontainers.image.version":%q}`, f.imageVersion), nil
		case strings.HasPrefix(cmd, "docker image inspect"):
			return "", fmt.Errorf("inspected the wrong image: %s", cmd)
		case strings.HasPrefix(cmd, "docker run"):
			f.runs++
			return f.script(context.Background())
		}
		return "", nil
	}
	return f
}

// deps for calling rotatePanelKey directly; out collects what it prints.
func (f *rotateFixture) deps(out *bytes.Buffer) *deps {
	run := func(ctx context.Context, w io.Writer, name string, a ...string) error {
		cmd := name + " " + strings.Join(a, " ")
		f.h.cmds = append(f.h.cmds, cmd)
		if strings.HasPrefix(cmd, "docker run") {
			f.runs++
			text, err := f.script(ctx)
			_, _ = io.WriteString(w, text)
			return err
		}
		text, err := f.h.answer(cmd)
		_, _ = io.WriteString(w, text)
		return err
	}
	return &deps{anyOS: true, units: f.h.units, run: run, out: out, layout: datadir.New(f.h.dataDir), geteuid: func() int { return 0 }}
}

func (f *rotateFixture) rotate(ctx context.Context, opts rotateKeyOptions) (string, error) {
	var out bytes.Buffer
	err := rotatePanelKey(ctx, f.deps(&out), opts)
	return out.String(), err
}

// sequence keeps the commands that change something, in order.
func (f *rotateFixture) sequence() []string {
	var out []string
	for _, c := range f.h.cmds {
		if strings.HasPrefix(c, "systemctl ") || strings.HasPrefix(c, "docker stop") || strings.HasPrefix(c, "docker run") || strings.HasPrefix(c, "docker rm") {
			out = append(out, c)
		}
	}
	return out
}

func TestRotateKeyRefuses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		setup func(f *rotateFixture)
		want  string
	}{
		{name: "no flag", args: nil, want: "exactly one flag"},
		{name: "both flags", args: []string{"--new-panel-identity", "--keep-panel-identity"}, want: "exactly one flag"},
		{name: "not root", args: []string{"--keep-panel-identity"}, setup: func(f *rotateFixture) { f.h.euid = 1000 },
			want: "run it as root: sudo seylo panel rotate-key --keep-panel-identity"},
		{name: "no panel data", args: []string{"--new-panel-identity"}, setup: func(f *rotateFixture) {
			_ = os.Remove(filepath.Join(f.panelDir, "master.key"))
		}, want: "this node does not run the panel"},
		{name: "no panel container", args: []string{"--new-panel-identity"}, setup: func(f *rotateFixture) {
			answer := f.h.answer
			f.h.answer = func(cmd string) (string, error) {
				if strings.HasPrefix(cmd, "docker ps --all") {
					return "", nil
				}
				return answer(cmd)
			}
		}, want: "this node does not run the panel: no panel container"},
		// The installer's "Already installed" path and a rolled back panel
		// update leave this binary next to an older panel image, whose
		// script rejects --from-cli with its usage text.
		{name: "an rc.1 panel image", args: []string{"--keep-panel-identity"}, setup: func(f *rotateFixture) { f.imageVersion = "0.2.0-rc.1" },
			want: "the panel runs 0.2.0-rc.1, whose image has no rotate-key support (it needs 0.2.0-rc.2 or newer); update the panel first (Settings > Updates)"},
		{name: "a 0.1 panel image", args: []string{"--new-panel-identity"}, setup: func(f *rotateFixture) { f.imageVersion = "0.1.1" },
			want: "the panel runs 0.1.1, whose image has no rotate-key support"},
		{name: "the panel's image cannot be inspected", args: []string{"--new-panel-identity"}, setup: func(f *rotateFixture) {
			answer := f.h.answer
			f.h.answer = func(cmd string) (string, error) {
				if strings.HasPrefix(cmd, "docker image inspect") {
					return "", errors.New("Error: No such image: sha256:img2")
				}
				return answer(cmd)
			}
		}, want: "inspecting the panel's image sha256:img2"},
		{name: "a rotation still running", args: []string{"--new-panel-identity"}, setup: func(f *rotateFixture) {
			answer := f.h.answer
			f.h.answer = func(cmd string) (string, error) {
				if strings.HasPrefix(cmd, "docker container inspect --format {{.State.Running}} seylo-rotate-key") {
					return "true", nil
				}
				return answer(cmd)
			}
		}, want: "an earlier rotation is still running"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRotateFixture(t)
			if tc.setup != nil {
				tc.setup(f)
			}
			_, err := f.h.run(append([]string{"panel", "rotate-key"}, tc.args...)...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if seq := f.sequence(); len(seq) != 0 {
				t.Fatalf("it changed something before refusing: %v", seq)
			}
		})
	}
}

// The tested manual steps, in order: agent down, panel down, the script
// from the panel's own image with the data dir mounted, the agent up (it
// starts the panel), the panel healthy, then the script's output.
func TestRotateKeyRunsTheSteps(t *testing.T) {
	f := newRotateFixture(t)
	out, err := f.h.run("panel", "rotate-key", "--new-panel-identity")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"systemctl stop seylo.service",
		"docker stop -t 30 c1",
		"docker run --rm --name seylo-rotate-key --network none --volume " + f.panelDir + ":/var/lib/seylo/panel " +
			"--env SEYLO_DATA_DIR=/var/lib/seylo/panel sha256:img2 bun apps/panel/dist/rotate-master-key.js --new-panel-identity --from-cli",
		"systemctl start seylo.service",
	}
	if got := f.sequence(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("commands:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	for _, c := range f.h.cmds {
		if strings.Contains(c, "panel start") || strings.Contains(c, "docker start") {
			t.Fatalf("the agent starts the panel itself, but the command also did: %s", c)
		}
	}
	if f.healthOK.Load() == 0 {
		t.Fatal("it did not wait for the panel on its host port")
	}
	running := strings.Index(out, "The panel is running with the new master.key.")
	script := strings.Index(out, "sudo seylo join 'https://203.0.113.7:3443'")
	if running < 0 || script < running {
		t.Fatalf("the script's output must follow the healthy panel:\n%s", out)
	}
	if strings.Contains(out, "The agent is running again") {
		t.Fatalf("success reads like an error path:\n%s", out)
	}
}

func TestRotateKeyKeepIdentityFlag(t *testing.T) {
	f := newRotateFixture(t)
	if _, err := f.h.run("panel", "rotate-key", "--keep-panel-identity"); err != nil {
		t.Fatal(err)
	}
	if seq := f.sequence(); len(seq) != 4 || !strings.HasSuffix(seq[2], "rotate-master-key.js --keep-panel-identity --from-cli") {
		t.Fatalf("commands = %v", seq)
	}
}

// Every way it can fail after the agent stopped starts the agent again.
func TestRotateKeyStartsTheAgentOnEveryError(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(f *rotateFixture)
		want []string
		err  string
	}{
		{name: "the agent does not stop", edit: func(f *rotateFixture) {
			f.h.units.fail = map[string]error{"stop seylo.service": errors.New("unit busy")}
		}, want: []string{"systemctl stop seylo.service", "systemctl start seylo.service"}, err: "stopping the agent"},
		{name: "the panel does not stop", edit: func(f *rotateFixture) {
			answer := f.h.answer
			f.h.answer = func(cmd string) (string, error) {
				if strings.HasPrefix(cmd, "docker stop") {
					return "", errors.New("daemon gone")
				}
				return answer(cmd)
			}
		}, want: []string{"systemctl stop seylo.service", "docker stop -t 30 c1", "systemctl start seylo.service"}, err: "stopping the panel"},
		{name: "the script fails", edit: func(f *rotateFixture) {
			f.script = func(context.Context) (string, error) {
				return "", errors.New("docker: exit status 1: A sealed value in git_credentials.secret_sealed does not open with master.key")
			}
		}, want: []string{"systemctl stop seylo.service", "docker stop -t 30 c1", "docker run", "docker rm --force seylo-rotate-key", "systemctl start seylo.service"},
			err: "master.key was not replaced"},
		{name: "the script fails after the rotation", edit: func(f *rotateFixture) {
			f.script = func(context.Context) (string, error) {
				_ = os.WriteFile(filepath.Join(f.panelDir, "master.key"), []byte("new\n"), 0o600)
				return "New master.key written\n", errors.New("docker: exit status 1: listing the nodes failed")
			}
		}, want: []string{"systemctl stop seylo.service", "docker stop -t 30 c1", "docker run", "docker rm --force seylo-rotate-key", "systemctl start seylo.service"},
			err: "master.key was replaced, but the script failed afterwards"},
		// Cut off twice with master.key.new left: the panel's start settles
		// it (finishes a committed rotation, else removes the file and keeps
		// the old key), so the message no longer says the panel refuses to start.
		{name: "the script is cut off twice", edit: func(f *rotateFixture) {
			f.script = func(context.Context) (string, error) {
				_ = os.WriteFile(filepath.Join(f.panelDir, "master.key.new"), []byte("k\n"), 0o600)
				return "", errors.New("docker: signal: killed")
			}
		}, want: []string{"systemctl stop seylo.service", "docker stop -t 30 c1", "docker run", "docker rm --force seylo-rotate-key",
			"docker run", "docker rm --force seylo-rotate-key", "systemctl start seylo.service"},
			err: "otherwise removes master.key.new and keeps the old key (`seylo panel logs` says which); if the old key stays, run this command again"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRotateFixture(t)
			tc.edit(f)
			out, err := f.rotate(context.Background(), rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL})
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Fatalf("err = %v, want %q", err, tc.err)
			}
			seq := f.sequence()
			if len(seq) != len(tc.want) {
				t.Fatalf("commands = %v, want %v", seq, tc.want)
			}
			for i := range seq {
				if !strings.HasPrefix(seq[i], tc.want[i]) {
					t.Fatalf("commands = %v, want %v", seq, tc.want)
				}
			}
			if !strings.Contains(out, "The agent is running again") {
				t.Fatalf("output does not say the agent is back:\n%s", out)
			}
		})
	}
}

// A script cut off part way (master.key.new left) runs once more, which
// finishes or undoes it; the agent starts after that.
func TestRotateKeyRerunsACutOffRotation(t *testing.T) {
	f := newRotateFixture(t)
	next := filepath.Join(f.panelDir, "master.key.new")
	f.script = func(context.Context) (string, error) {
		if f.runs == 1 {
			_ = os.WriteFile(next, []byte("k\n"), 0o600)
			return "", errors.New("docker: signal: killed")
		}
		_ = os.Remove(next)
		return "Finished an earlier rotation that stopped before master.key was replaced.\n", nil
	}
	out, err := f.rotate(context.Background(), rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL})
	if err != nil {
		t.Fatal(err)
	}
	if f.runs != 2 || !strings.Contains(out, "Finished an earlier rotation") {
		t.Fatalf("runs = %d, output:\n%s", f.runs, out)
	}
	seq := f.sequence()
	if seq[len(seq)-1] != "systemctl start seylo.service" || !strings.HasPrefix(seq[3], "docker rm --force seylo-rotate-key") {
		t.Fatalf("commands = %v", seq)
	}
}

// Ctrl-C before the script: nothing changes and the agent comes back.
func TestRotateKeyInterruptedBeforeTheScript(t *testing.T) {
	f := newRotateFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.h.units.onCall = func(call string) {
		if call == "stop seylo.service" {
			cancel()
		}
	}
	_, err := f.rotate(ctx, rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL})
	if err == nil || !strings.Contains(err.Error(), "interrupted before anything changed") {
		t.Fatalf("err = %v", err)
	}
	if seq := f.sequence(); strings.Join(seq, ",") != "systemctl stop seylo.service,systemctl start seylo.service" {
		t.Fatalf("commands = %v", seq)
	}
}

// Ctrl-C while the script runs: it runs to its end (its context is not the
// command's), the agent starts and the output is printed, without waiting
// for the panel.
func TestRotateKeyInterruptedDuringTheScript(t *testing.T) {
	f := newRotateFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.script = func(scriptCtx context.Context) (string, error) {
		cancel()
		if scriptCtx.Err() != nil {
			return "", scriptCtx.Err()
		}
		return rotateScriptOutput, nil
	}
	out, err := f.rotate(ctx, rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL})
	if err == nil || !strings.Contains(err.Error(), "the rotation is done and the agent is running") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out, "--pin 'sha256:new'") {
		t.Fatalf("the re-join commands are missing:\n%s", out)
	}
	if seq := f.sequence(); seq[len(seq)-1] != "systemctl start seylo.service" {
		t.Fatalf("commands = %v", seq)
	}
}

// A panel that does not come back still gets the script's output printed.
func TestRotateKeyPanelNotHealthy(t *testing.T) {
	f := newRotateFixture(t)
	f.status.Store(http.StatusServiceUnavailable)
	out, err := f.rotate(context.Background(), rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL, Timeout: 1500 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "the panel did not answer") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out, "--pin 'sha256:new'") {
		t.Fatalf("the re-join commands are missing:\n%s", out)
	}
}

// Ctrl-C while waiting for the panel stops the wait, not the output.
func TestRotateKeyInterruptedWhileWaiting(t *testing.T) {
	f := newRotateFixture(t)
	f.status.Store(http.StatusServiceUnavailable)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.h.units.onCall = func(call string) {
		if call == "start seylo.service" {
			time.AfterFunc(200*time.Millisecond, cancel)
		}
	}
	out, err := f.rotate(ctx, rotateKeyOptions{NewIdentity: true, healthBase: f.health.URL, Timeout: time.Minute})
	if err == nil || !strings.Contains(err.Error(), "interrupted: the rotation is done") {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(out, "--pin 'sha256:new'") {
		t.Fatalf("the re-join commands are missing:\n%s", out)
	}
}

func TestFindPanelContainers(t *testing.T) {
	f := newRotateFixture(t)
	var out bytes.Buffer
	p, err := findPanelContainers(context.Background(), f.deps(&out))
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(f.health.URL)
	if p.image != "sha256:img2" || strings.Join(p.running, ",") != "c1" || fmt.Sprint(p.hostPort) != u.Port() || p.version != "0.2.0-rc.2" {
		t.Fatalf("panel = %+v", p)
	}
}

// Releases before rotate-key are refused; newer ones and builds without a
// release version ("dev", no label) run.
func TestRotateSupported(t *testing.T) {
	for _, v := range []string{"0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "v0.2.1", "1.0.0", "dev", ""} {
		if err := rotateSupported(v); err != nil {
			t.Errorf("%q: %v", v, err)
		}
	}
	for _, v := range []string{"0.2.0-rc.1", "v0.2.0-rc.1", "0.1.1", "0.1.0"} {
		if err := rotateSupported(v); err == nil || !strings.Contains(err.Error(), "update the panel first") {
			t.Errorf("%q: err = %v", v, err)
		}
	}
}

// A current panel image runs the rotation; a dev build (no release label) too.
func TestRotateKeyRunsOnACurrentOrDevImage(t *testing.T) {
	for _, v := range []string{"0.2.0-rc.2", "0.2.0", "dev", ""} {
		f := newRotateFixture(t)
		f.imageVersion = v
		if _, err := f.h.run("panel", "rotate-key", "--keep-panel-identity"); err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if f.runs != 1 {
			t.Fatalf("%q: the script ran %d times", v, f.runs)
		}
	}
}

// The script's runner keeps it out of the terminal's process group, so
// Ctrl-C does not reach it, and runs it to its end on a cancelled context.
func TestShieldedRunner(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	if err := shieldedRunner(ctx, &out, "sh", "-c", "sleep 0.1; ps -o pgid= -p $$"); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out.String()); got == "" || got == fmt.Sprint(syscall.Getpgrp()) {
		t.Fatalf("child process group %q, ours %d", got, syscall.Getpgrp())
	}
	if err := shieldedRunner(context.Background(), io.Discard, "sh", "-c", "echo no >&2; exit 3"); err == nil || !strings.Contains(err.Error(), "no") {
		t.Fatalf("err = %v", err)
	}
}
