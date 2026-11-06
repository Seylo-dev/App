package build

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Cmd is one external command of a build (git, docker, railpack, ...).
type Cmd struct {
	Name string
	Args []string
	Dir  string
	// Env is added to a minimal base environment (PATH, HOME, DOCKER_HOST
	// and the like), never to the agent's full environment, so nothing the
	// agent was started with leaks into builds.
	Env    []string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

func (c Cmd) String() string {
	return c.Name + " " + strings.Join(c.Args, " ")
}

// Runner runs commands. The real one is ExecRunner; tests use a fake.
type Runner interface {
	// Run waits for the command. A non-zero exit is an *ExitError.
	// Cancelling ctx kills the whole process group.
	Run(ctx context.Context, cmd Cmd) error
}

// ExitError is a command that ran and failed.
type ExitError struct {
	Cmd  string
	Code int
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("%s exited with code %d", e.Cmd, e.Code)
}

// ExecRunner runs commands with os/exec.
type ExecRunner struct{}

// passEnv are the agent variables commands inherit. DOCKER_HOST and
// friends let tests point builds at another daemon.
var passEnv = []string{"PATH", "HOME", "LANG", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"}

func baseEnv() []string {
	env := make([]string, 0, len(passEnv)+1)
	for _, k := range passEnv {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	if _, ok := os.LookupEnv("PATH"); !ok {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	return env
}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, c Cmd) error {
	cmd := exec.Command(c.Name, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = append(baseEnv(), c.Env...)
	cmd.Stdin = c.Stdin
	cmd.Stdout = c.Stdout
	cmd.Stderr = c.Stderr
	// Own process group, so cancelling kills buildx and git helpers too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting %s: %w", c.Name, err)
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		case <-done:
		}
	}()
	err := cmd.Wait()
	close(done)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return &ExitError{Cmd: c.Name, Code: exitErr.ExitCode()}
	}
	if err != nil {
		return fmt.Errorf("running %s: %w", c.Name, err)
	}
	return nil
}

// output runs cmd and returns its trimmed stdout. Stderr goes to errOut
// (may be nil) and its tail is added to the error.
func output(ctx context.Context, r Runner, cmd Cmd) (string, error) {
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := r.Run(ctx, cmd); err != nil {
		if msg := lastLine(errb.String()); msg != "" {
			return "", fmt.Errorf("%w: %s", err, msg)
		}
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 300 {
		s = s[len(s)-300:]
	}
	return s
}
