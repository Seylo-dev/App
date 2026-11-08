package update

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/internal/systemd"
)

// systemctlAs is a Runner that checks it was asked to restart the agent
// and runs script with sh in its place, so the exit is a real process's.
func systemctlAs(t *testing.T, script string) systemd.Runner {
	return func(ctx context.Context, stdout io.Writer, name string, args ...string) error {
		if got := name + " " + strings.Join(args, " "); got != "systemctl --no-block restart "+systemd.AgentUnit {
			t.Errorf("ran %q", got)
		}
		return systemd.ExecRunner(ctx, stdout, "sh", "-c", script)
	}
}

func TestRestartAgentKilledByTheUnitStopIsSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh and POSIX signals")
	}
	cases := []struct {
		name   string
		script string
		ok     bool
	}{
		// systemd stops seylo.service and kills systemctl with it.
		{"killed with the unit", "kill -TERM $$", true},
		{"queued and exited", "exit 0", true},
		{"unknown unit", "echo 'Failed to restart seylo.service: Unit seylo.service not found.' >&2; exit 5", false},
		{"exit before the stop", "exit 1", false},
		{"killed by something else", "kill -KILL $$", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &SystemdSystem{Run: systemctlAs(t, c.script)}
			err := s.RestartAgent(context.Background())
			if (err == nil) != c.ok {
				t.Fatalf("RestartAgent = %v, want ok=%v", err, c.ok)
			}
		})
	}
	t.Run("systemctl missing", func(t *testing.T) {
		s := &SystemdSystem{Run: func(ctx context.Context, stdout io.Writer, _ string, args ...string) error {
			return systemd.ExecRunner(ctx, stdout, "/nonexistent/systemctl", args...)
		}}
		if err := s.RestartAgent(context.Background()); err == nil {
			t.Fatal("a missing systemctl must be an error")
		}
	})
}

// syncBuffer is a bytes.Buffer safe for a logger and the test at once.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// restartingSystem fakes the guard but restarts with SystemdSystem.
type restartingSystem struct {
	*fakeSystem
	real *SystemdSystem
	done chan error
}

func (r *restartingSystem) RestartAgent(ctx context.Context) error {
	err := r.real.RestartAgent(ctx)
	r.done <- err
	return err
}

// The update's restart goroutine logs an ERROR only for a real failure;
// the guard stays armed then, so it restores the old binary.
func TestAgentUpdateRestartErrorOnlyWhenTheRestartFailed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs sh and POSIX signals")
	}
	for _, c := range []struct {
		name, script string
		wantError    bool
	}{
		{"killed with the unit", "kill -TERM $$", false},
		{"unknown unit", "echo 'Unit seylo.service not found.' >&2; exit 5", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newAgentFixture(t, "1.2.0")
			sys := &restartingSystem{fakeSystem: f.system, real: &SystemdSystem{Run: systemctlAs(t, c.script)}, done: make(chan error, 1)}
			var logs syncBuffer
			u, err := NewAgentUpdater(AgentOptions{
				DataDir: f.dataDir, Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: f.key.publicText(t),
				GOOS: "linux", GOARCH: "amd64", System: sys, Report: f.reports.add, RestartDelay: time.Millisecond,
				Logger: slog.New(slog.NewTextHandler(&logs, nil)),
			}, &Lock{})
			if err != nil {
				t.Fatal(err)
			}
			if err := u.Update(context.Background(), f.request(testManifest("1.2.0", f.binary, f.server.URL))); err != nil {
				t.Fatal(err)
			}
			select {
			case <-sys.done:
			case <-time.After(5 * time.Second):
				t.Fatal("the agent was not restarted")
			}
			const msg = "restarting into the new agent failed"
			deadline := time.Now().Add(2 * time.Second)
			for c.wantError && !strings.Contains(logs.String(), msg) && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if !c.wantError {
				time.Sleep(50 * time.Millisecond) // the goroutine logs right after the restart returns
			}
			out := logs.String()
			if got := strings.Contains(out, "level=ERROR msg=\""+msg); got != c.wantError {
				t.Fatalf("ERROR logged = %v, want %v; log:\n%s", got, c.wantError, out)
			}
			sys.mu.Lock()
			armed, disarmed := len(sys.armed), sys.disarmed
			sys.mu.Unlock()
			if armed != 1 || disarmed != 0 {
				t.Fatalf("guard armed %d, disarmed %d: it must stay armed until the new agent confirms", armed, disarmed)
			}
		})
	}
}
