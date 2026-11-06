package agent

// Runtime wiring: the Docker engine, reconcile, health, crash policy and
// volumes.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/crash"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/reconcile"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/volumes"
)

// newDockerEngine builds the Docker engine; tests replace it with a fake.
var newDockerEngine = func() (docker.Engine, error) { return docker.NewMoby("") }

// provideRuntime sets d.Docker (first: every later area uses it) and
// d.Prober. Nothing dials Docker yet, so the agent starts while Docker is
// down and the reconcile loop retries.
func provideRuntime(d *Deps) error {
	if d.Docker == nil {
		eng, err := newDockerEngine()
		if err != nil {
			return err
		}
		d.Docker = eng
	}
	if d.Prober == nil {
		eng := d.Docker
		d.Prober = health.NewProber(health.ExecFunc(func(ctx context.Context, id string, cmd []string, max int) (int, []byte, error) {
			res, err := eng.ExecRun(ctx, id, cmd, max)
			return res.ExitCode, res.Output, err
		}))
	}
	return nil
}

// wireRuntime builds the reconcile runtime, registers the rest of the
// state.sync.v1 methods and volume.transfer.v1, and adds the reconcile loop and
// the Docker facts loop.
func wireRuntime(reg *Registry, d *Deps) error {
	opts := reconcile.Options{
		Docker:     d.Docker,
		Prober:     d.Prober,
		Crash:      crash.NewTracker(nil),
		Layout:     d.Layout,
		Logger:     d.Logger.With("component", "reconcile"),
		Desired:    d.Desired,
		Feed:       d.Feed,
		State:      d.State,
		Reports:    d.Reports,
		Events:     d.Events,
		Router:     d.Router,
		Cloudflare: d.Cloudflare,
	}
	if d.DesiredSync != nil {
		opts.Accept = d.DesiredSync
	}
	if d.Gate != nil {
		opts.Gate = d.Gate
	}
	if d.Logs != nil {
		opts.Logs = d.Logs
	}
	rt, err := reconcile.New(opts)
	if err != nil {
		return err
	}
	d.Reconcile = rt
	d.Components.Add("reconcile", rt.Run)
	d.Components.Add("docker-facts", func(ctx context.Context) error { return dockerFacts(ctx, d) })

	rpc.HandleUnary(reg, "SyncDesired", func(ctx context.Context, req *agentv1.SyncDesiredRequest) (*agentv1.SyncDesiredResponse, error) {
		if req.GetState() == nil {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "no desired state")
		}
		rev, refused, err := rt.Sync(ctx, req.GetState())
		if err != nil {
			return nil, runtimeStatus(err)
		}
		return &agentv1.SyncDesiredResponse{AcceptedRevision: rev, Refused: refused}, nil
	})
	rpc.HandleUnary(reg, "ApplyService", func(ctx context.Context, req *agentv1.ApplyServiceRequest) (*agentv1.ApplyServiceResponse, error) {
		rev, err := rt.Apply(ctx, req.GetRevision(), req.GetService())
		if err != nil {
			return nil, runtimeStatus(err)
		}
		return &agentv1.ApplyServiceResponse{AcceptedRevision: rev}, nil
	})
	rpc.HandleUnary(reg, "RemoveService", func(ctx context.Context, req *agentv1.RemoveServiceRequest) (*agentv1.RemoveServiceResponse, error) {
		rev, err := rt.Remove(ctx, req.GetRevision(), req.GetServiceId(), req.GetDeleteData())
		if err != nil {
			return nil, runtimeStatus(err)
		}
		return &agentv1.RemoveServiceResponse{AcceptedRevision: rev}, nil
	})
	rpc.HandleUnary(reg, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {
		if err := rt.Restart(ctx, req.GetServiceId()); err != nil {
			return nil, runtimeStatus(err)
		}
		return &agentv1.RestartServiceResponse{}, nil
	})

	tr := &volumes.Transfer{
		Layout: d.Layout,
		Running: func(ctx context.Context, serviceID string) (bool, error) {
			list, err := d.Docker.ListContainers(ctx, map[string]string{docker.LabelService: serviceID})
			if err != nil {
				return false, err
			}
			for _, c := range list {
				if docker.IsServiceInstance(c.Labels) && c.State == agentv1.InstanceState_INSTANCE_STATE_RUNNING {
					return true, nil
				}
			}
			return false, nil
		},
	}
	rpc.HandleRaw(reg, "ExportVolume", func(ctx context.Context, req *agentv1.ExportVolumeRequest, s rpc.RawStream) (*agentv1.ExportVolumeResponse, error) {
		owner := volumeOwner(rt.Current(), req.GetServiceId(), req.GetVolume())
		n, err := tr.Export(ctx, owner, req.GetVolume(), s)
		if err != nil {
			return nil, runtimeStatus(err)
		}
		return &agentv1.ExportVolumeResponse{SizeBytes: n}, nil
	})
	rpc.HandleRaw(reg, "ImportVolume", func(ctx context.Context, req *agentv1.ImportVolumeRequest, s rpc.RawStream) (*agentv1.ImportVolumeResponse, error) {
		owner := volumeOwner(rt.Current(), req.GetServiceId(), req.GetVolume())
		n, err := tr.Import(ctx, req.GetServiceId(), owner, req.GetVolume(), req.GetReplace(), s)
		if err != nil {
			// Drain what the panel still sends so the stream ends cleanly.
			_, _ = io.Copy(io.Discard, s)
			return nil, runtimeStatus(err)
		}
		return &agentv1.ImportVolumeResponse{SizeBytes: n}, nil
	})
	return nil
}

// volumeOwner finds the service whose folder holds a volume: compose
// members may mount a volume another member owns.
func volumeOwner(desired *agentv1.DesiredState, serviceID, volume string) string {
	for _, s := range desired.GetServices() {
		if s.GetId() != serviceID {
			continue
		}
		for _, v := range s.GetVolumes() {
			if v.GetName() == volume && v.GetOwnerServiceId() != "" {
				return v.GetOwnerServiceId()
			}
		}
	}
	return serviceID
}

// runtimeStatus maps runtime errors to user-facing statuses; anything not
// listed stays an internal error.
func runtimeStatus(err error) error {
	code := agentv1.StatusCode_STATUS_CODE_UNSPECIFIED
	switch {
	case errors.Is(err, reconcile.ErrInvalidSpec), errors.Is(err, state.ErrInvalidDesired),
		errors.Is(err, datadir.ErrInvalidID), errors.Is(err, volumes.ErrBadArchive):
		code = agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT
	case errors.Is(err, reconcile.ErrUnknownService), errors.Is(err, volumes.ErrNoVolume):
		code = agentv1.StatusCode_STATUS_CODE_NOT_FOUND
	case errors.Is(err, volumes.ErrNotEmpty), errors.Is(err, volumes.ErrRunning), errors.Is(err, reconcile.ErrServiceStopped):
		code = agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION
	case errors.Is(err, docker.ErrUnavailable):
		code = agentv1.StatusCode_STATUS_CODE_UNAVAILABLE
	case errors.Is(err, context.Canceled):
		code = agentv1.StatusCode_STATUS_CODE_CANCELLED
	case errors.Is(err, context.DeadlineExceeded):
		code = agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED
	}
	if code == agentv1.StatusCode_STATUS_CODE_UNSPECIFIED {
		return err
	}
	return rpc.NewError(code, err.Error())
}

// dockerFacts keeps the Docker part of the node facts current. An error
// while Docker is down makes the component restart with backoff.
func dockerFacts(ctx context.Context, d *Deps) error {
	for {
		info, err := d.Docker.Info(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("reading docker info: %w", err)
		}
		d.Facts.Update(func(f *agentv1.NodeFacts) {
			f.DockerVersion = info.Version
			f.DockerApiVersion = info.APIVersion
			f.CgroupVersion = info.CgroupVersion
		})
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Minute):
		}
	}
}
