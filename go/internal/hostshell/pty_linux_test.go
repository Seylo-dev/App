//go:build linux

package hostshell

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// readAll collects a session's output until it ends.
func readAll(s *Session) <-chan string {
	out := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, s)
		out <- buf.String()
	}()
	return out
}

func on() error { return nil }

func TestShellRunsHostnameAndExits(t *testing.T) {
	m := New(Options{Allowed: on})
	s, err := m.Open(context.Background(), &agentv1.HostShellOpen{Size: &agentv1.TerminalSize{Columns: 100, Rows: 30}, OpenedBy: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Count() != 1 {
		t.Fatalf("open shells = %d", m.Count())
	}
	if s.Info().GetHostname() == "" || !strings.HasPrefix(s.Info().GetCommand()[0], "-") || s.Info().GetIdleTimeoutSeconds() != 900 {
		t.Fatalf("info = %v", s.Info())
	}
	out := readAll(s)
	if _, err := s.Write([]byte("stty size; hostname; exit 3\n")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	code, err := s.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
	text := <-out
	host, _ := os.Hostname()
	if !strings.Contains(text, host) || !strings.Contains(text, "30 100") {
		t.Fatalf("output %q lacks the hostname %q or the size 30 100", text, host)
	}
	if s.EndReason() != ReasonExited {
		t.Fatalf("reason = %q", s.EndReason())
	}
	waitFor(t, func() bool { return m.Count() == 0 })
}

func TestAtMostTwoAndCloseAll(t *testing.T) {
	allowed := atomic.Bool{}
	allowed.Store(true)
	m := New(Options{Allowed: func() error {
		if !allowed.Load() {
			return ErrDisabled
		}
		return nil
	}})
	a, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open(context.Background(), &agentv1.HostShellOpen{}); !errors.Is(err, ErrBusy) {
		t.Fatalf("third shell: err = %v, want ErrBusy", err)
	}
	// The setting turns off: both are hung up and new ones are refused.
	allowed.Store(false)
	m.CloseAll(ReasonDisabled)
	for _, s := range []*Session{a, b} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		code, err := s.Wait(ctx)
		cancel()
		if err != nil || code < 128 {
			t.Fatalf("closed shell: code %d, err %v (want a signal exit)", code, err)
		}
		if s.EndReason() != ReasonDisabled {
			t.Fatalf("reason = %q", s.EndReason())
		}
	}
	waitFor(t, func() bool { return m.Count() == 0 })
	if _, err := m.Open(context.Background(), &agentv1.HostShellOpen{}); !errors.Is(err, ErrDisabled) {
		t.Fatalf("after turning off: err = %v", err)
	}
}

// The setting turns off while a shell starts: Open refuses it and it must
// not stay counted, or two such races would refuse every later shell.
func TestTurnedOffWhileStartingIsNotCounted(t *testing.T) {
	var calls atomic.Int32
	m := New(Options{Allowed: func() error {
		// Calls 1 and 3 are the checks before a start, 2 and 4 the
		// rechecks after it: off by then. From call 5 on it stays on.
		if n := calls.Add(1); n == 2 || n == 4 {
			return ErrDisabled
		}
		return nil
	}})
	for range 2 {
		if _, err := m.Open(context.Background(), &agentv1.HostShellOpen{}); !errors.Is(err, ErrDisabled) {
			t.Fatalf("err = %v, want ErrDisabled", err)
		}
		if n := m.Count(); n != 0 {
			t.Fatalf("open shells after a refused start = %d, want 0", n)
		}
	}
	s, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatalf("third shell: %v", err)
	}
	if m.Count() != 1 {
		t.Fatalf("open shells = %d, want 1", m.Count())
	}
	_ = s.Close()
	waitFor(t, func() bool { return m.Count() == 0 })
}

func TestIdleShellIsHungUp(t *testing.T) {
	m := New(Options{Allowed: on, Idle: 200 * time.Millisecond})
	s, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatal(err)
	}
	out := readAll(s)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := s.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	<-out
	if s.EndReason() != ReasonIdle {
		t.Fatalf("reason = %q, want idle", s.EndReason())
	}
}

func TestCloseEndsABlockedRead(t *testing.T) {
	m := New(Options{Allowed: on})
	s, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatal(err)
	}
	out := readAll(s)
	// A background job keeps the PTY open; Close must still end the read.
	if _, err := s.Write([]byte("sleep 300 &\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	_ = s.Close()
	select {
	case <-out:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not end the read")
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for range 200 {
		if ok() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

func TestShellDoesNotKeepTheAgentsOOMProtection(t *testing.T) {
	if os.Getuid() != 0 {
		t.Skip("needs root to lower the agent's own OOM score")
	}
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("-500"), 0); err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { _ = os.WriteFile("/proc/self/oom_score_adj", []byte("0"), 0) })
	m := New(Options{Allowed: on})
	s, err := m.Open(context.Background(), &agentv1.HostShellOpen{})
	if err != nil {
		t.Fatal(err)
	}
	out := readAll(s)
	if _, err := s.Write([]byte("cat /proc/self/oom_score_adj; exit\n")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := s.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	text := <-out
	if strings.Contains(text, "-500") {
		t.Fatalf("the shell kept the agent's OOM score: %q", text)
	}
	// The value follows the shell's own escape codes on the line.
	if !regexp.MustCompile(`[\r\nl]0\r?\n`).MatchString(text) {
		t.Fatalf("output %q has no oom_score_adj of 0", text)
	}
}
