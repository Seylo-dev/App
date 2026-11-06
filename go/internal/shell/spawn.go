package shell

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// PTY is a running shell process.
type PTY interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, size *agentv1.TerminalSize) error
	// Wait blocks until the process exits and returns its exit code.
	Wait(ctx context.Context) (int32, error)
}

// Described is implemented by PTYs that know where they run; the Shell
// handler sends it as the stream's first message.
type Described interface {
	Info() *agentv1.ShellInfo
}

// Spawner starts shells.
type Spawner interface {
	Spawn(ctx context.Context, open *agentv1.ShellOpen) (PTY, error)
}

// Execer runs short non-interactive commands (the Exec RPC).
type Execer interface {
	Exec(ctx context.Context, req *agentv1.ExecRequest) (*agentv1.ExecResponse, error)
}
