package jobrun

import (
	"bytes"
	"strings"
	"sync"
)

// Tail keeps the last lines written to it, with secret values replaced,
// for cron run results and error messages. It is safe for concurrent
// writers (stdout and stderr share one Tail).
type Tail struct {
	mu      sync.Mutex
	max     int
	lines   []string
	partial []byte
	secrets []string
}

// maxLine bounds one stored line so a binary blob cannot blow up a report.
const maxLine = 4096

// NewTail keeps the last max lines. secrets are replaced by "[redacted]";
// values shorter than 4 characters are ignored (they would redact noise).
func NewTail(max int, secrets []string) *Tail {
	t := &Tail{max: max}
	for _, s := range secrets {
		if len(s) >= 4 {
			t.secrets = append(t.secrets, s)
		}
	}
	return t
}

// Write implements io.Writer.
func (t *Tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := len(p)
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			t.partial = append(t.partial, p...)
			if len(t.partial) > maxLine {
				t.push(t.partial)
				t.partial = t.partial[:0]
			}
			break
		}
		t.partial = append(t.partial, p[:i]...)
		t.push(t.partial)
		t.partial = t.partial[:0]
		p = p[i+1:]
	}
	return n, nil
}

func (t *Tail) push(line []byte) {
	s := strings.TrimRight(string(line), "\r")
	if len(s) > maxLine {
		s = s[:maxLine]
	}
	t.lines = append(t.lines, s)
	if over := len(t.lines) - t.max; over > 0 {
		t.lines = append(t.lines[:0], t.lines[over:]...)
	}
}

// Add appends a line written by the agent itself (for example why a run
// failed).
func (t *Tail) Add(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.push([]byte(line))
}

// Lines returns the kept lines, including an unterminated last one, with
// secrets redacted.
func (t *Tail) Lines() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]string, 0, len(t.lines)+1)
	out = append(out, t.lines...)
	if len(t.partial) > 0 {
		out = append(out, string(t.partial))
	}
	if over := len(out) - t.max; over > 0 {
		out = out[over:]
	}
	for i, l := range out {
		out[i] = t.redact(l)
	}
	return out
}

// String is the kept lines joined by newlines.
func (t *Tail) String() string { return strings.Join(t.Lines(), "\n") }

func (t *Tail) redact(s string) string {
	for _, sec := range t.secrets {
		s = strings.ReplaceAll(s, sec, "[redacted]")
	}
	return s
}
