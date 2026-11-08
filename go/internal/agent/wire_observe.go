package agent

// Observe wiring: logs, metrics, console, shell, files and exec.

import (
	"context"
	"errors"
	"io"
	iofs "io/fs"
	"path/filepath"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/console"
	"github.com/seylo-dev/app/go/internal/console/dockerapi"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/fs"
	"github.com/seylo-dev/app/go/internal/logs"
	"github.com/seylo-dev/app/go/internal/metrics"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/shell"
)

// observeDocker is the Docker API the observe area uses (logs capture,
// stats, attach, exec). Tests replace newObserveDocker with a fake.
type observeDocker interface {
	logs.Source
	metrics.Source
	console.Docker
	shell.Docker
}

var newObserveDocker = func() observeDocker { return dockerapi.New("") }

// logPruneEvery is how often age retention runs over every log.
const logPruneEvery = 10 * time.Minute

// provideObserve sets d.Logs, d.Metrics and d.Files.
func provideObserve(d *Deps) error {
	d.Logs = logs.NewFileStore(d.Layout)
	d.Metrics = metrics.NewDockerCollector(newObserveDocker(), d.Layout.Root(), 0)
	d.Files = fs.VolumeRoots{Resolve: func(root *agentv1.FsRoot) (string, error) {
		return resolveVolume(d, root)
	}}
	return nil
}

// resolveVolume finds a volume in the desired state; the folder belongs to
// the volume's owner service (compose members share one).
func resolveVolume(d *Deps, root *agentv1.FsRoot) (string, error) {
	svc := desiredService(d, root.GetServiceId())
	for _, v := range svc.GetVolumes() {
		if v.GetName() != root.GetVolume() {
			continue
		}
		owner := v.GetOwnerServiceId()
		if owner == "" {
			owner = svc.GetId()
		}
		return d.Layout.ServiceVolume(owner, v.GetName())
	}
	return "", fs.ErrUnknownVolume
}

func desiredService(d *Deps, id string) *agentv1.ServiceSpec {
	for _, s := range d.Feed.Current().GetServices() {
		if s.GetId() == id {
			return s
		}
	}
	return nil
}

// wireObserve registers Exec, Console, Shell, the Fs* methods, LogsFollow,
// LogsSearch, GetMetrics and WatchMetrics, and adds the log capture, log
// retention, metrics and orphan-shell loops.
func wireObserve(reg *Registry, d *Deps) error {
	dk := newObserveDocker()
	shells := shell.New(dk, shell.Options{
		Service:        func(id string) *agentv1.ServiceSpec { return desiredService(d, id) },
		DatabaseClient: dbtools.ClientCommand,
	})

	registerLogs(reg, d)
	registerMetrics(reg, d)
	registerFiles(reg, d)
	registerTerminals(reg, console.NewAttacher(dk), shells)
	rpc.HandleUnary(reg, "Exec", func(ctx context.Context, req *agentv1.ExecRequest) (*agentv1.ExecResponse, error) {
		resp, err := shells.Exec(ctx, req)
		return resp, observeStatus(err)
	})

	if store, ok := d.Logs.(*logs.FileStore); ok {
		d.Feed.Subscribe(func(ds *agentv1.DesiredState) {
			store.SetRetention(logs.RetentionFrom(ds.GetSettings().GetLogRetention()))
		})
		capturer := logs.NewCapturer(dk, store, filepath.Join(d.Layout.Root(), "logs", ".cursors.json"), d.Logger.With("component", "logs"))
		d.Components.Add("logs-capture", capturer.Run)
		d.Components.Add("logs-retention", func(ctx context.Context) error {
			t := time.NewTicker(logPruneEvery)
			defer t.Stop()
			for {
				if err := store.Prune(); err != nil {
					d.Logger.Warn("log retention", "err", err)
				}
				select {
				case <-ctx.Done():
					return nil
				case <-t.C:
				}
			}
		})
	}
	d.Components.Add("metrics", func(ctx context.Context) error {
		return d.Metrics.Run(ctx, func(r *agentv1.MetricsReport) {
			d.Events.Emit(&agentv1.Event{Payload: &agentv1.Event_Metrics{Metrics: r}})
		})
	})
	d.Components.Add("shell-orphans", func(context.Context) error {
		if n := shell.DefaultSweeper().KillOrphans(); n > 0 {
			d.Logger.Info("killed shells left by the previous agent", "processes", n)
		}
		return nil
	})
	return nil
}

func registerLogs(reg *Registry, d *Deps) {
	rpc.HandleStream(reg, "LogsFollow", func(ctx context.Context, first *agentv1.LogsFollowRequest, s *rpc.TypedStream[*agentv1.LogsFollowRequest, *agentv1.LogsFollowResponse]) error {
		return observeStatus(d.Logs.Follow(ctx, first, func(es []*agentv1.LogEntry) error {
			return s.Send(&agentv1.LogsFollowResponse{Entries: es})
		}))
	})
	rpc.HandleUnary(reg, "LogsSearch", func(ctx context.Context, req *agentv1.LogsSearchRequest) (*agentv1.LogsSearchResponse, error) {
		resp, err := d.Logs.Search(ctx, req)
		return resp, observeStatus(err)
	})
}

func registerMetrics(reg *Registry, d *Deps) {
	// The agent keeps only its latest sample; the panel has the history.
	rpc.HandleUnary(reg, "GetMetrics", func(_ context.Context, req *agentv1.GetMetricsRequest) (*agentv1.GetMetricsResponse, error) {
		var since time.Time
		if req.GetSince() != nil {
			since = req.GetSince().AsTime()
		}
		return &agentv1.GetMetricsResponse{Samples: d.Metrics.History(since, req.GetServiceIds())}, nil
	})
	rpc.HandleStream(reg, "WatchMetrics", func(ctx context.Context, first *agentv1.WatchMetricsRequest, s *rpc.TypedStream[*agentv1.WatchMetricsRequest, *agentv1.WatchMetricsResponse]) error {
		return observeStatus(d.Metrics.Watch(ctx, first.GetInterval().AsDuration(), first.GetServiceIds(), func(r *agentv1.MetricsReport) error {
			return s.Send(&agentv1.WatchMetricsResponse{Sample: r})
		}))
	})
}

// withFS opens the request's volume, runs fn and closes it.
func withFS[T any](d *Deps, root *agentv1.FsRoot, fn func(fs.FS) (T, error)) (T, error) {
	var zero T
	f, err := d.Files.Open(root)
	if err != nil {
		return zero, observeStatus(err)
	}
	defer f.Close()
	out, err := fn(f)
	if err != nil {
		return zero, observeStatus(err)
	}
	return out, nil
}

func registerFiles(reg *Registry, d *Deps) {
	rpc.HandleUnary(reg, "FsList", func(ctx context.Context, req *agentv1.FsListRequest) (*agentv1.FsListResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsListResponse, error) {
			entries, err := f.List(ctx, req.GetPath())
			return &agentv1.FsListResponse{Entries: entries}, err
		})
	})
	rpc.HandleUnary(reg, "FsStat", func(ctx context.Context, req *agentv1.FsStatRequest) (*agentv1.FsStatResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsStatResponse, error) {
			info, err := f.Stat(ctx, req.GetPath())
			return &agentv1.FsStatResponse{Info: info}, err
		})
	})
	rpc.HandleRaw(reg, "FsRead", func(ctx context.Context, req *agentv1.FsReadRequest, s rpc.RawStream) (*agentv1.FsReadResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsReadResponse, error) {
			rc, info, err := f.Open(ctx, req.GetPath(), req.GetOffset(), req.GetLength())
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			if _, err := io.CopyBuffer(s, rc, make([]byte, 32<<10)); err != nil {
				return nil, err
			}
			return &agentv1.FsReadResponse{Info: info}, nil
		})
	})
	rpc.HandleRaw(reg, "FsWrite", func(ctx context.Context, req *agentv1.FsWriteRequest, s rpc.RawStream) (*agentv1.FsWriteResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsWriteResponse, error) {
			up, err := f.Create(ctx, req)
			if err != nil {
				return nil, err
			}
			if _, err := io.CopyBuffer(up, s, make([]byte, 32<<10)); err != nil {
				_ = up.Abort()
				return nil, err
			}
			if err := ctx.Err(); err != nil {
				_ = up.Abort()
				return nil, err
			}
			info, err := up.Commit()
			return &agentv1.FsWriteResponse{Info: info}, err
		})
	})
	rpc.HandleUnary(reg, "FsMkdir", func(ctx context.Context, req *agentv1.FsMkdirRequest) (*agentv1.FsMkdirResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsMkdirResponse, error) {
			return &agentv1.FsMkdirResponse{}, f.Mkdir(ctx, req.GetPath(), req.GetParents())
		})
	})
	rpc.HandleUnary(reg, "FsRename", func(ctx context.Context, req *agentv1.FsRenameRequest) (*agentv1.FsRenameResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsRenameResponse, error) {
			return &agentv1.FsRenameResponse{}, f.Rename(ctx, req.GetFrom(), req.GetTo())
		})
	})
	rpc.HandleUnary(reg, "FsDelete", func(ctx context.Context, req *agentv1.FsDeleteRequest) (*agentv1.FsDeleteResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsDeleteResponse, error) {
			return &agentv1.FsDeleteResponse{}, f.Remove(ctx, req.GetPaths())
		})
	})
	rpc.HandleUnary(reg, "FsChmod", func(ctx context.Context, req *agentv1.FsChmodRequest) (*agentv1.FsChmodResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsChmodResponse, error) {
			return &agentv1.FsChmodResponse{}, f.Chmod(ctx, req.GetPath(), req.GetMode())
		})
	})
	rpc.HandleUnary(reg, "FsArchive", func(ctx context.Context, req *agentv1.FsArchiveRequest) (*agentv1.FsArchiveResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsArchiveResponse, error) {
			info, err := f.Archive(ctx, req.GetPaths(), req.GetDestination(), req.GetFormat())
			return &agentv1.FsArchiveResponse{Archive: info}, err
		})
	})
	rpc.HandleUnary(reg, "FsExtract", func(ctx context.Context, req *agentv1.FsExtractRequest) (*agentv1.FsExtractResponse, error) {
		return withFS(d, req.GetRoot(), func(f fs.FS) (*agentv1.FsExtractResponse, error) {
			return &agentv1.FsExtractResponse{}, f.Extract(ctx, req.GetArchivePath(), req.GetDestination())
		})
	})
}

// terminalChunk is the most output one message carries.
const terminalChunk = 32 << 10

func registerTerminals(reg *Registry, attacher console.Attacher, spawner shell.Spawner) {
	rpc.HandleStream(reg, "Console", func(ctx context.Context, first *agentv1.ConsoleRequest, s *rpc.TypedStream[*agentv1.ConsoleRequest, *agentv1.ConsoleResponse]) error {
		open := first.GetOpen()
		if open == nil {
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "the first console message must be open")
		}
		sess, err := attacher.Attach(ctx, open)
		if err != nil {
			return observeStatus(err)
		}
		defer sess.Close()
		stop := context.AfterFunc(ctx, func() { _ = sess.Close() })
		defer stop()
		info := sess.Info()
		if err := s.Send(&agentv1.ConsoleResponse{Message: &agentv1.ConsoleResponse_Info{Info: info}}); err != nil {
			return err
		}
		go func() {
			for {
				req, err := s.Recv()
				if err != nil {
					return // half-closed or gone: output keeps flowing until ctx ends
				}
				switch m := req.GetMessage().(type) {
				case *agentv1.ConsoleRequest_Stdin:
					// Without an open stdin the input is dropped; Info told the UI.
					if info.GetStdinOpen() {
						if _, err := sess.Write(m.Stdin); err != nil {
							_ = sess.Close()
							return
						}
					}
				case *agentv1.ConsoleRequest_Resize:
					_ = sess.Resize(ctx, m.Resize)
				}
			}
		}()
		if err := pumpOutput(sess, func(b []byte) error {
			return s.Send(&agentv1.ConsoleResponse{Message: &agentv1.ConsoleResponse_Output{Output: b}})
		}); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if code, err := sess.Wait(wctx); err == nil {
			return s.Send(&agentv1.ConsoleResponse{Message: &agentv1.ConsoleResponse_ExitCode{ExitCode: code}})
		}
		return nil
	})

	rpc.HandleStream(reg, "Shell", func(ctx context.Context, first *agentv1.ShellRequest, s *rpc.TypedStream[*agentv1.ShellRequest, *agentv1.ShellResponse]) error {
		open := first.GetOpen()
		if open == nil {
			return rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "the first shell message must be open")
		}
		pty, err := spawner.Spawn(ctx, open)
		if err != nil {
			return observeStatus(err)
		}
		defer pty.Close()
		if d, ok := pty.(shell.Described); ok && d.Info() != nil {
			if err := s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_Info{Info: d.Info()}}); err != nil {
				return err
			}
		}
		stop := context.AfterFunc(ctx, func() { _ = pty.Close() })
		defer stop()
		go func() {
			for {
				req, err := s.Recv()
				if err != nil {
					// The terminal was closed: hang the shell up.
					_ = pty.Close()
					return
				}
				switch m := req.GetMessage().(type) {
				case *agentv1.ShellRequest_Input:
					if _, err := pty.Write(m.Input); err != nil {
						_ = pty.Close()
						return
					}
				case *agentv1.ShellRequest_Resize:
					_ = pty.Resize(ctx, m.Resize)
				}
			}
		}()
		if err := pumpOutput(pty, func(b []byte) error {
			return s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_Output{Output: b}})
		}); err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if code, err := pty.Wait(wctx); err == nil {
			return s.Send(&agentv1.ShellResponse{Message: &agentv1.ShellResponse_ExitCode{ExitCode: code}})
		}
		return nil
	})
}

// pumpOutput sends everything r produces until it ends. A read error is
// the end of the process or a closed session, not a failure.
func pumpOutput(r io.Reader, send func([]byte) error) error {
	buf := make([]byte, terminalChunk)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if serr := send(append([]byte(nil), buf[:n]...)); serr != nil {
				return serr
			}
		}
		if err != nil {
			return nil
		}
	}
}

// observeStatus turns the observe packages' errors into user-facing
// statuses. Anything unknown stays as is and becomes INTERNAL.
func observeStatus(err error) error {
	if err == nil {
		return nil
	}
	var rpcErr *rpc.Error
	if errors.As(err, &rpcErr) {
		return err
	}
	code := agentv1.StatusCode_STATUS_CODE_UNSPECIFIED
	msg := err.Error()
	switch {
	case errors.Is(err, context.Canceled):
		return err
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, shell.ErrTimeout):
		code = agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED
	case errors.Is(err, dockerapi.ErrNoContainer):
		code, msg = agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, "the service has no running container on this node"
	case dockerapi.IsConflict(err):
		code = agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION
	case dockerapi.IsNotFound(err):
		code, msg = agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "container not found"
	case errors.Is(err, fs.ErrUnknownVolume), errors.Is(err, iofs.ErrNotExist):
		code = agentv1.StatusCode_STATUS_CODE_NOT_FOUND
	case errors.Is(err, iofs.ErrExist):
		code = agentv1.StatusCode_STATUS_CODE_ALREADY_EXISTS
	case errors.Is(err, fs.ErrEscape), errors.Is(err, iofs.ErrPermission):
		code = agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED
	case errors.Is(err, fs.ErrNoSpace):
		code = agentv1.StatusCode_STATUS_CODE_RESOURCE_EXHAUSTED
	case errors.Is(err, fs.ErrInvalidPath), errors.Is(err, fs.ErrNotDir), errors.Is(err, fs.ErrIsDir),
		errors.Is(err, fs.ErrNotRegular), errors.Is(err, fs.ErrUnsafeEntry),
		errors.Is(err, logs.ErrInvalidTarget), errors.Is(err, logs.ErrBadQuery), errors.Is(err, logs.ErrBadCursor),
		errors.Is(err, shell.ErrNotDatabase), errors.Is(err, shell.ErrBadCommand):
		code = agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT
	case errors.Is(err, console.ErrStdinClosed):
		code = agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION
	default:
		return err
	}
	return rpc.NewError(code, msg)
}
