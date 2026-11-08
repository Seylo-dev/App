package agent

// Build wiring: builds, the registry relay, Tunnel and compose.

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/compose"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// parseComposeTimeout bounds one ParseCompose call.
const parseComposeTimeout = 30 * time.Second

// provideBuild: set d.Builder.
func provideBuild(d *Deps) error {
	opts := build.Options{
		Dir:      d.Layout.BuildsDir(),
		ToolsDir: d.Layout.ToolsDir(),
		Logger:   d.Logger.With("component", "build"),
		Parallel: 1,
		Git:      build.GitNodeConfig{ProxyResolves: d.Config.GitProxyResolves, ConfigFile: d.Layout.ConfigFile()},
	}
	if d.Events != nil {
		opts.Emit = d.Events.Emit
	}
	if d.Reports != nil {
		opts.Report = d.Reports.Event
	}
	d.Builder = build.New(opts)
	return nil
}

// wireBuild registers Build, CancelBuild, UploadBuildContext
// (build.run.v1), Tunnel (tunnel.tcp.v1) and ParseCompose
// (compose.parse.v1), and runs the build maintenance loop, the buildx
// facts, the 127.0.0.1:5755 registry relay and the registry garbage
// collector.
func wireBuild(reg *Registry, d *Deps) error {
	log := d.Logger.With("component", "build")
	wireBuildxFacts(d, dockerBuildxVersion(filepath.Join(d.Layout.BuildsDir(), "docker")))

	var teed sync.Map // build id -> struct{}: output already copied to the log store
	rpc.HandleStream(reg, "Build", func(ctx context.Context, req *agentv1.BuildRequest, s *rpc.TypedStream[*agentv1.BuildRequest, *agentv1.BuildResponse]) error {
		job, err := d.Builder.Start(req)
		if err != nil {
			return buildStatus(err)
		}
		if _, seen := teed.LoadOrStore(job.ID, struct{}{}); !seen && d.Logs != nil {
			go teeBuildLog(d, log, job)
		}
		// The build is detached: if this stream ends (panel cancel or a
		// dropped connection) it keeps going, its result goes through the
		// outbox, and Build with the same id re-attaches. CancelBuild stops it.
		return job.Watch(ctx, s.Send)
	})
	rpc.HandleUnary(reg, "CancelBuild", func(_ context.Context, req *agentv1.CancelBuildRequest) (*agentv1.CancelBuildResponse, error) {
		if err := d.Builder.Cancel(req.GetBuildId()); err != nil {
			return nil, buildStatus(err)
		}
		return &agentv1.CancelBuildResponse{}, nil
	})
	rpc.HandleRaw(reg, "UploadBuildContext", func(ctx context.Context, req *agentv1.UploadBuildContextRequest, s rpc.RawStream) (*agentv1.UploadBuildContextResponse, error) {
		if err := d.Builder.StoreContext(ctx, req, s); err != nil {
			return nil, buildStatus(err)
		}
		return &agentv1.UploadBuildContextResponse{}, nil
	})

	server := &registry.Server{DataDir: d.Layout.RegistryDir(), Logger: d.Logger.With("component", "registry")}
	tunnel := &registry.Tunnel{Dial: &registry.NodeDialer{Registry: server}, Logger: d.Logger.With("component", "tunnel")}
	rpc.HandleRaw(reg, "Tunnel", tunnel.Serve)

	rpc.HandleUnary(reg, "ParseCompose", func(ctx context.Context, req *agentv1.ParseComposeRequest) (*agentv1.ParseComposeResponse, error) {
		ctx, cancel := context.WithTimeout(ctx, parseComposeTimeout)
		defer cancel()
		resp, err := compose.Parse(ctx, req)
		var inv *compose.InvalidError
		if errors.As(err, &inv) {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, inv.Msg)
		}
		return resp, err
	})

	if svc, ok := d.Builder.(*build.Service); ok {
		// Compose files from any git repository (build.git-file.v1).
		rpc.HandleUnary(reg, "FetchGitFile", func(ctx context.Context, req *agentv1.FetchGitFileRequest) (*agentv1.FetchGitFileResponse, error) {
			res, err := svc.FetchFile(ctx, req)
			if err != nil {
				return nil, gitFileStatus(err)
			}
			return res, nil
		})
		d.Components.Add("build-maintenance", svc.Run)
		if d.Feed != nil {
			d.Feed.Subscribe(func(ds *agentv1.DesiredState) {
				svc.SetParallel(int(ds.GetSettings().GetMaxParallelBuilds()))
			})
		}
	}
	relay := &registry.TCPRelay{Logger: d.Logger.With("component", "registry-relay")}
	d.Components.Add("registry-relay", func(ctx context.Context) error {
		if d.PanelPeer == nil {
			return errors.New("no panel link")
		}
		return relay.Run(ctx, d.PanelPeer)
	})
	d.Components.Add("registry-gc", server.RunGC)
	log.Debug("build, registry and compose wired")
	return nil
}

// wireBuildxFacts adds the buildx-facts loop (NodeFacts.buildx, see
// buildx_facts.go). It checks again right away when the panel turns builds
// on, so the owner who just ticked Can build sees the real answer.
func wireBuildxFacts(d *Deps, version buildxVersionFunc) *buildxFacts {
	bx := newBuildxFacts(d, version)
	d.Components.Add("buildx-facts", bx.run)
	if d.Feed != nil {
		// The loop checks at start anyway: only a later switch to on asks again.
		var on atomic.Bool
		on.Store(d.Feed.Settings().GetMaxParallelBuilds() > 0)
		d.Feed.Subscribe(func(ds *agentv1.DesiredState) {
			now := ds.GetSettings().GetMaxParallelBuilds() > 0
			if was := on.Swap(now); now && !was {
				bx.Recheck()
			}
		})
	}
	return bx
}

// gitFileStatus maps FetchGitFile errors to statuses; the messages carry
// no credentials (git's own output is not passed on).
func gitFileStatus(err error) error {
	switch {
	case errors.Is(err, build.ErrGitFileNotFound):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, err.Error())
	case errors.Is(err, build.ErrGitFileTooLarge):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, err.Error())
	case errors.Is(err, build.ErrFetch), errors.Is(err, build.ErrNoGit):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, err.Error())
	}
	return buildStatus(err)
}

// buildStatus turns builder errors into user-facing statuses.
func buildStatus(err error) error {
	var inv *build.InvalidError
	switch {
	case errors.As(err, &inv):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, inv.Msg)
	case errors.Is(err, build.ErrNotFound):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "no such build on this node")
	default:
		return err
	}
}

// teeBuildLog copies a build's output into the node's log store, so
// LogsFollow{build_id} can follow it too (also after the panel restarts).
func teeBuildLog(d *Deps, log *slog.Logger, job *build.Job) {
	w, err := d.Logs.BuildLog(job.ID)
	if err != nil {
		log.Warn("build log store", "build", job.ID, "err", err)
		return
	}
	defer w.Close()
	_ = job.Watch(context.Background(), func(r *agentv1.BuildResponse) error {
		if b := r.GetLog(); len(b) > 0 {
			_, err := w.Write(b)
			return err
		}
		return nil
	})
}
