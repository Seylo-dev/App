// Ported from the Wings fork's server/shell/sweep.go.
//
// MIT License
//
// Copyright (c) 2018 - 2021 Dane Everitt <dane@daneeveritt.com> and Contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package shell

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/seylo-dev/app/go/gen/brand"
)

// MarkerEnv tags every process a shell or exec started. The exec carries it
// in its environment and everything started from it inherits it.
var MarkerEnv = strings.ToUpper(brand.Slug) + "_SHELL_SESSION"

// markerPrefix starts our marker values, so orphan cleanup never touches
// processes tagged by anything else.
const markerPrefix = "agent-"

// Sweeper finds the processes of a session in /proc and signals them.
//
// Docker does not end a TTY exec when its client goes away: it only stops
// copying, and the shell sits in the container forever. So on the way out
// the agent (root, next to Docker) signals every process that carries the
// session's marker, only inside the container's pid namespace.
type Sweeper struct {
	// ProcRoot is where /proc is. Tests point it at a fake one.
	ProcRoot string
	// Kill signals a process.
	Kill func(pid int, sig syscall.Signal) error
	// Self is the agent's own pid, never signalled. os.Getpid() when zero.
	Self int
}

// DefaultSweeper works on the real /proc.
func DefaultSweeper() Sweeper {
	return Sweeper{ProcRoot: "/proc", Kill: syscall.Kill}
}

// PidNamespace returns the pid namespace of a process ("pid:[4026532...]"),
// or "" when it cannot be read.
func (sw Sweeper) PidNamespace(pid int) string {
	if pid < 1 {
		return ""
	}
	ns, err := os.Readlink(filepath.Join(sw.ProcRoot, strconv.Itoa(pid), "ns", "pid"))
	if err != nil {
		return ""
	}
	return ns
}

// hasEnv reports whether a process' environment holds the exact entry, or
// one starting with needle when prefix is true.
func (sw Sweeper) hasEnv(entry, needle string, prefix bool) bool {
	environ, err := os.ReadFile(filepath.Join(sw.ProcRoot, entry, "environ"))
	if err != nil {
		return false
	}
	for _, v := range bytes.Split(environ, []byte{0}) {
		if prefix && bytes.HasPrefix(v, []byte(needle)) {
			return true
		}
		if !prefix && string(v) == needle {
			return true
		}
	}
	return false
}

func (sw Sweeper) self() int {
	if sw.Self > 0 {
		return sw.Self
	}
	return os.Getpid()
}

// each calls fn for every process in /proc but the agent itself.
func (sw Sweeper) each(fn func(entry string, pid int)) {
	entries, err := os.ReadDir(sw.ProcRoot)
	if err != nil {
		return
	}
	self := sw.self()
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid < 1 || pid == self {
			continue
		}
		fn(e.Name(), pid)
	}
}

// KillMarked signals every process in the pid namespace whose environment
// carries the marker and returns how many it signalled. Nothing is
// signalled without a namespace: a session's processes are only ever looked
// for inside its container.
func (sw Sweeper) KillMarked(marker, pidNamespace string, sig syscall.Signal) int {
	if marker == "" || pidNamespace == "" {
		return 0
	}
	needle := MarkerEnv + "=" + marker
	n := 0
	sw.each(func(entry string, pid int) {
		// The namespace first: one readlink rules out every process on the host.
		if ns, err := os.Readlink(filepath.Join(sw.ProcRoot, entry, "ns", "pid")); err != nil || ns != pidNamespace {
			return
		}
		if !sw.hasEnv(entry, needle, false) {
			return
		}
		if sw.Kill(pid, sig) == nil {
			n++
		}
	})
	return n
}

// KillOrphans kills what sessions of an earlier agent left behind: when the
// agent stops, the sessions' streams go with it, but their shells stay in
// the containers. No session survives a restart, so at start every process
// carrying our marker is an orphan. Processes in the agent's own pid
// namespace (the host's) are never touched.
func (sw Sweeper) KillOrphans() int {
	own := sw.PidNamespace(sw.self())
	if own == "" {
		return 0
	}
	n := 0
	sw.each(func(entry string, pid int) {
		ns, err := os.Readlink(filepath.Join(sw.ProcRoot, entry, "ns", "pid"))
		if err != nil || ns == own || !strings.HasPrefix(ns, "pid:") {
			return
		}
		if !sw.hasEnv(entry, MarkerEnv+"="+markerPrefix, true) {
			return
		}
		if sw.Kill(pid, syscall.SIGKILL) == nil {
			n++
		}
	})
	return n
}
