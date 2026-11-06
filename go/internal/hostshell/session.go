package hostshell

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// hangUpGrace is how long the shell's processes get after SIGHUP before
// SIGKILL.
const hangUpGrace = 2 * time.Second

// Reasons a session ended, from endReason.
const (
	ReasonExited   = "exited"
	ReasonClosed   = "closed"
	ReasonIdle     = "idle"
	ReasonDisabled = "disabled"
)

// Session is one running host shell. Read and Write are the PTY; the
// process is reaped by the session itself.
type Session struct {
	manager   *Manager
	openedBy  string
	sessionID string
	started   time.Time
	master    *os.File
	cmd       *exec.Cmd
	info      *agentv1.HostShellInfo

	// done closes once the shell process exited and was reaped.
	done     chan struct{}
	exitCode int32

	lastActive atomic.Int64
	closeOnce  sync.Once
	mu         sync.Mutex
	reason     string
}

func (s *Session) touch() { s.lastActive.Store(time.Now().UnixNano()) }

// Info describes where the shell runs; the handler sends it first.
func (s *Session) Info() *agentv1.HostShellInfo { return s.info }

// Read reads the shell's output. The end of the shell is io.EOF.
func (s *Session) Read(p []byte) (int, error) {
	n, err := s.master.Read(p)
	if n > 0 {
		s.touch()
	}
	if err != nil {
		// Linux answers EIO once the shell side of the PTY is gone, and a
		// closed session answers ErrClosed: both are the end.
		if errors.Is(err, syscall.EIO) || errors.Is(err, os.ErrClosed) {
			err = io.EOF
		}
	}
	return n, err
}

// Write types into the shell.
func (s *Session) Write(p []byte) (int, error) {
	s.touch()
	return s.master.Write(p)
}

// Resize sets the terminal size.
func (s *Session) Resize(size *agentv1.TerminalSize) error {
	return setSize(s.master, size)
}

// Wait returns the shell's exit code once it exited (128 + signal when a
// signal ended it).
func (s *Session) Wait(ctx context.Context) (int32, error) {
	select {
	case <-s.done:
		return s.exitCode, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// Close hangs the shell up.
func (s *Session) Close() error {
	s.closeWith(ReasonClosed)
	return nil
}

// endReason says why the session ended: ReasonExited when the shell exited
// by itself, else what closed it.
func (s *Session) endReason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reason == "" {
		return ReasonExited
	}
	return s.reason
}

// EndReason is endReason for the handler (ReasonIdle gets a note).
func (s *Session) EndReason() string { return s.endReason() }

func (s *Session) closeWith(reason string) {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		select {
		case <-s.done:
		default:
			s.reason = reason
		}
		s.mu.Unlock()
		if s.cmd != nil && s.cmd.Process != nil {
			hangUp(s.cmd.Process.Pid)
			go func() {
				select {
				case <-s.done:
				case <-time.After(hangUpGrace):
					kill(s.cmd.Process.Pid)
				}
			}()
		}
		if s.master != nil {
			_ = s.master.Close()
		}
	})
}

// watchIdle hangs up after idle without input or output.
func (s *Session) watchIdle(idle time.Duration) {
	check := min(idle/4, 30*time.Second)
	t := time.NewTicker(check)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			if time.Since(time.Unix(0, s.lastActive.Load())) >= idle {
				s.closeWith(ReasonIdle)
				return
			}
		}
	}
}

// start runs the login shell on a new PTY.
func (s *Session) start(_ context.Context, l login, size *agentv1.TerminalSize) error {
	master, tty, err := openPTY()
	if err != nil {
		return err
	}
	if size.GetColumns() > 0 && size.GetRows() > 0 {
		if err := setSize(master, size); err != nil {
			_ = master.Close()
			_ = tty.Close()
			return err
		}
	}
	// Not exec.CommandContext: the shell belongs to the session, not to the
	// call that opened it; Close and the idle watch end it.
	cmd := &exec.Cmd{
		Path:        l.shell,
		Args:        []string{l.argv0()},
		Env:         l.env(),
		Dir:         l.home,
		Stdin:       tty,
		Stdout:      tty,
		Stderr:      tty,
		SysProcAttr: sessionAttr(),
	}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		_ = tty.Close()
		return err
	}
	// The shell holds its own copy; ours would keep the PTY open after it
	// exits.
	_ = tty.Close()
	resetOOM(cmd.Process.Pid)
	s.master, s.cmd, s.started = master, cmd, time.Now()
	s.touch()
	hostname, _ := os.Hostname()
	s.info = &agentv1.HostShellInfo{
		User:               l.user,
		WorkingDir:         l.home,
		Hostname:           hostname,
		Command:            []string{l.argv0()},
		IdleTimeoutSeconds: uint32(s.manager.opts.Idle / time.Second),
	}
	go func() {
		_ = cmd.Wait()
		s.exitCode = exitCode(cmd.ProcessState)
		close(s.done)
	}()
	return nil
}

func exitCode(ps *os.ProcessState) int32 {
	if ps == nil {
		return -1
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int32(ws.Signal())
	}
	return int32(ps.ExitCode())
}
