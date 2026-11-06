package console

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Session is an attached console. Read returns the replayed tail first,
// then live output; Write sends stdin.
type Session interface {
	io.ReadWriteCloser
	// Info says which container this is and whether stdin is open.
	Info() *agentv1.ConsoleInfo
	// Resize changes the TTY size (containers with a TTY only).
	Resize(ctx context.Context, size *agentv1.TerminalSize) error
	// Wait blocks until the container stops and returns its exit code.
	Wait(ctx context.Context) (int32, error)
}

// Attacher opens console sessions.
type Attacher interface {
	Attach(ctx context.Context, open *agentv1.ConsoleOpen) (Session, error)
}
