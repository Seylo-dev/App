//go:build !linux

package hostshell

import (
	"os"
	"syscall"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func openPTY() (master, tty *os.File, err error) { return nil, nil, ErrUnsupported }

func setSize(*os.File, *agentv1.TerminalSize) error { return ErrUnsupported }

func sessionAttr() *syscall.SysProcAttr { return nil }

func hangUp(int) {}

func kill(int) {}

func resetOOM(int) {}
