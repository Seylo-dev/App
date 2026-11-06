package jobrun

import (
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
)

// Exec runs argv inside a running container with env, feeding stdin when
// given, and returns the combined output (capped at 64 KiB) and the exit
// code. Secrets belong in env or stdin, never in argv.
func (d *Docker) Exec(ctx context.Context, container string, argv, env []string, stdin io.Reader) (string, int, error) {
	ex, err := d.cli.ExecCreate(ctx, container, client.ExecCreateOptions{
		Cmd: argv, Env: env, AttachStdout: true, AttachStderr: true, AttachStdin: stdin != nil,
	})
	if err != nil {
		return "", -1, fmt.Errorf("exec in %s: %w", container, err)
	}
	att, err := d.cli.ExecAttach(ctx, ex.ID, client.ExecAttachOptions{})
	if err != nil {
		return "", -1, fmt.Errorf("exec in %s: %w", container, err)
	}
	defer att.Close()
	if stdin != nil {
		go func() {
			_, _ = io.Copy(att.Conn, stdin)
			_ = att.CloseWrite()
		}()
	}
	var out capped
	if _, err := stdcopy.StdCopy(&out, &out, att.Reader); err != nil && ctx.Err() != nil {
		return out.String(), -1, ctx.Err()
	}
	ins, err := d.cli.ExecInspect(ctx, ex.ID, client.ExecInspectOptions{})
	if err != nil {
		return out.String(), -1, fmt.Errorf("exec in %s: %w", container, err)
	}
	return out.String(), ins.ExitCode, nil
}

// capped keeps the first 64 KiB written to it.
type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := 64<<10 - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
