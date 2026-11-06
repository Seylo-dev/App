package agent

import (
	"context"
	"errors"
	"fmt"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/hostshell"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// errNoHostShellConfig is the refusal when config.yml sets no_host_shell.
var errNoHostShellConfig = fmt.Errorf("%w: this node's config.yml sets no_host_shell", hostshell.ErrDisabled)

// errHostShellOff is the refusal while NodeSettings.host_shell is off.
var errHostShellOff = fmt.Errorf("%w: the owner has not allowed host shells for this node", hostshell.ErrDisabled)

// newHostShells is the HostShell gate: the panel's node setting and
// config.yml's no_host_shell are both read here, on the node, for every
// shell, so a panel that only skipped its own check gets nothing.
func newHostShells(d *Deps) *hostshell.Manager {
	return hostshell.New(hostshell.Options{
		Allowed: func() error {
			if d.Config.NoHostShell {
				return errNoHostShellConfig
			}
			if !d.Feed.Settings().GetHostShell() {
				return errHostShellOff
			}
			return nil
		},
		Logger: d.Logger.With("component", "host-shell"),
	})
}

// registerHostShell registers HostShell (node.host-shell.v1) and closes
// every open host shell when the setting turns off.
func registerHostShell(reg *Registry, d *Deps) {
	shells := newHostShells(d)
	d.Feed.Subscribe(func(st *agentv1.DesiredState) {
		if !st.GetSettings().GetHostShell() {
			shells.CloseAll(hostshell.ReasonDisabled)
		}
	})
	rpc.HandleStream(reg, "HostShell", func(ctx context.Context, first *agentv1.HostShellRequest, s *rpc.TypedStream[*agentv1.HostShellRequest, *agentv1.HostShellResponse]) error {
		open := first.GetOpen()
		if open == nil {
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "the first host shell message must be open")
		}
		sess, err := shells.Open(ctx, open)
		if err != nil {
			return hostShellStatus(err)
		}
		defer sess.Close()
		if err := s.Send(&agentv1.HostShellResponse{Message: &agentv1.HostShellResponse_Info{Info: sess.Info()}}); err != nil {
			return err
		}
		stop := context.AfterFunc(ctx, func() { _ = sess.Close() })
		defer stop()
		go func() {
			for {
				req, err := s.Recv()
				if err != nil {
					// The terminal was closed: hang the shell up.
					_ = sess.Close()
					return
				}
				switch m := req.GetMessage().(type) {
				case *agentv1.HostShellRequest_Input:
					if _, err := sess.Write(m.Input); err != nil {
						_ = sess.Close()
						return
					}
				case *agentv1.HostShellRequest_Resize:
					_ = sess.Resize(m.Resize)
				}
			}
		}()
		send := func(b []byte) error {
			return s.Send(&agentv1.HostShellResponse{Message: &agentv1.HostShellResponse_Output{Output: b}})
		}
		if err := pumpOutput(sess, send); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch sess.EndReason() {
		case hostshell.ReasonIdle:
			_ = send([]byte(fmt.Sprintf("\r\nClosed after %d minutes without input or output.\r\n", int(shells.Idle()/time.Minute))))
		case hostshell.ReasonDisabled:
			_ = send([]byte("\r\nClosed: host shells were turned off for this node.\r\n"))
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if code, err := sess.Wait(wctx); err == nil {
			return s.Send(&agentv1.HostShellResponse{Message: &agentv1.HostShellResponse_ExitCode{ExitCode: code}})
		}
		return nil
	})
}

// hostShellStatus maps the gate's refusals to statuses the panel shows.
func hostShellStatus(err error) error {
	switch {
	case errors.Is(err, hostshell.ErrDisabled):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED, err.Error())
	case errors.Is(err, hostshell.ErrBusy):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED, err.Error())
	case errors.Is(err, hostshell.ErrUnsupported):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, err.Error())
	}
	return rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, "starting the shell: "+err.Error())
}
