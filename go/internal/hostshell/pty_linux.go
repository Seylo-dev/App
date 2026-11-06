//go:build linux

package hostshell

import (
	"fmt"
	"os"
	"strconv"
	"syscall"

	"golang.org/x/sys/unix"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// openPTY opens a new pseudo terminal pair. The master stays in Go's
// poller (its ioctls go through SyscallConn, never Fd), so closing it ends
// a blocked Read.
func openPTY() (master, tty *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("opening /dev/ptmx: %w", err)
	}
	var n uint32
	err = control(master, func(fd int) error {
		if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
			return fmt.Errorf("unlocking the pty: %w", err)
		}
		var err error
		n, err = unix.IoctlGetUint32(fd, unix.TIOCGPTN)
		return err
	})
	if err != nil {
		_ = master.Close()
		return nil, nil, err
	}
	name := "/dev/pts/" + strconv.FormatUint(uint64(n), 10)
	tty, err = os.OpenFile(name, os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("opening %s: %w", name, err)
	}
	return master, tty, nil
}

func setSize(master *os.File, size *agentv1.TerminalSize) error {
	if size.GetColumns() == 0 || size.GetRows() == 0 {
		return nil
	}
	ws := &unix.Winsize{Col: uint16(min(size.GetColumns(), 1000)), Row: uint16(min(size.GetRows(), 1000))}
	return control(master, func(fd int) error { return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, ws) })
}

func control(f *os.File, fn func(fd int) error) error {
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var inner error
	if err := rc.Control(func(fd uintptr) { inner = fn(int(fd)) }); err != nil {
		return err
	}
	return inner
}

// sessionAttr starts the shell as the leader of a new session with the PTY
// as its controlling terminal (child fd 0), like a login.
func sessionAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
}

// hangUp sends SIGHUP (and SIGCONT, for stopped jobs) to the shell's
// process group, like a terminal that went away.
func hangUp(pid int) {
	_ = syscall.Kill(-pid, syscall.SIGHUP)
	_ = syscall.Kill(-pid, syscall.SIGCONT)
}

func kill(pid int) { _ = syscall.Kill(-pid, syscall.SIGKILL) }
