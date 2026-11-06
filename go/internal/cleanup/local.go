package cleanup

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// Docker is the inventory cleanup needs (*jobrun.Docker in the agent).
// Every Remove call re-checks the managed label itself.
type Docker interface {
	ContainersWithSize(ctx context.Context) ([]jobrun.Container, error)
	Images(ctx context.Context) ([]jobrun.Image, error)
	Volumes(ctx context.Context) ([]jobrun.Volume, error)
	Networks(ctx context.Context) ([]jobrun.Network, error)
	RemoveContainer(ctx context.Context, id string) error
	RemoveImage(ctx context.Context, id string) error
	RemoveVolume(ctx context.Context, name string) error
	RemoveNetwork(ctx context.Context, id string) error
}

// CachePruner prunes the build cache of Seylo's own builder. Docker's
// machine-wide build cache is never pruned, so without one the report
// says build cache cleanup is not supported.
type CachePruner interface {
	PruneCache(ctx context.Context, dryRun bool) (reclaimedBytes uint64, items []string, err error)
}

// Options configure a Local pruner.
type Options struct {
	Docker Docker
	Layout datadir.Layout
	// Desired returns the node's current desired state (never nil).
	Desired func() *agentv1.DesiredState
	// Cache may be nil.
	Cache  CachePruner
	Logger *slog.Logger
}

// Local is the agent's Pruner.
type Local struct {
	opts Options
	// One prune at a time: two would race on the same resources.
	mu sync.Mutex
}

var _ Pruner = (*Local)(nil)

// NewLocal returns a pruner.
func NewLocal(opts Options) *Local {
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	return &Local{opts: opts}
}

// Prune implements Pruner.
func (l *Local) Prune(ctx context.Context, req *agentv1.PruneRequest) (*agentv1.PruneResponse, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	snap, err := l.snapshot(ctx, req)
	if err != nil {
		return nil, err
	}
	items, notes := Plan(req, snap)
	resp := &agentv1.PruneResponse{}
	for _, it := range items {
		if req.GetDryRun() {
			resp.Removed = append(resp.Removed, it.Describe())
			resp.ReclaimedBytes += uint64(max(it.Size, 0))
			continue
		}
		if err := l.remove(ctx, it); err != nil {
			l.opts.Logger.Warn("cleanup could not remove", "kind", it.Kind, "name", it.Name, "err", err)
			resp.Removed = append(resp.Removed, fmt.Sprintf("not removed: %s %s: %v", it.Kind, it.Name, err))
			continue
		}
		resp.Removed = append(resp.Removed, it.Describe())
		resp.ReclaimedBytes += uint64(max(it.Size, 0))
	}
	if req.GetBuildCache() {
		if l.opts.Cache == nil {
			notes = append(notes, "build cache: not supported on this node")
		} else {
			n, lines, err := l.opts.Cache.PruneCache(ctx, req.GetDryRun())
			if err != nil {
				notes = append(notes, "build cache: "+err.Error())
			}
			resp.ReclaimedBytes += n
			resp.Removed = append(resp.Removed, lines...)
		}
	}
	resp.Removed = append(resp.Removed, notes...)
	if !req.GetDryRun() {
		l.opts.Logger.Info("cleanup done", "reclaimed_bytes", resp.GetReclaimedBytes(), "items", len(items))
	}
	return resp, nil
}

func (l *Local) snapshot(ctx context.Context, req *agentv1.PruneRequest) (Snapshot, error) {
	s := Snapshot{Desired: l.opts.Desired()}
	var err error
	// Containers decide what is in use, so every kind needs them.
	if s.Containers, err = l.opts.Docker.ContainersWithSize(ctx); err != nil {
		return s, err
	}
	if req.GetImages() {
		if s.Images, err = l.opts.Docker.Images(ctx); err != nil {
			return s, err
		}
	}
	if req.GetStoppedContainers() {
		if s.Networks, err = l.opts.Docker.Networks(ctx); err != nil {
			return s, err
		}
	}
	if req.GetOrphanedServiceData() {
		if s.Volumes, err = l.opts.Docker.Volumes(ctx); err != nil {
			return s, err
		}
		if s.ServiceDirs, err = l.serviceDirs(ctx); err != nil {
			return s, err
		}
	}
	return s, nil
}

// serviceDirs lists services/<id> folders with their sizes.
func (l *Local) serviceDirs(ctx context.Context) ([]ServiceDir, error) {
	probe, err := l.opts.Layout.ServiceDir("probe")
	if err != nil {
		return nil, err
	}
	root := filepath.Dir(probe)
	entries, err := os.ReadDir(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []ServiceDir
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p, err := l.opts.Layout.ServiceDir(e.Name())
		if err != nil {
			continue // not a folder we create
		}
		size, err := dirSize(ctx, p)
		if err != nil {
			return nil, err
		}
		out = append(out, ServiceDir{ServiceID: e.Name(), Path: p, Size: size})
	}
	return out, nil
}

func dirSize(ctx context.Context, dir string) (int64, error) {
	var n int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n, err
}

func (l *Local) remove(ctx context.Context, it Item) error {
	switch it.Kind {
	case KindContainer:
		return l.opts.Docker.RemoveContainer(ctx, it.ID)
	case KindImage:
		return l.opts.Docker.RemoveImage(ctx, it.ID)
	case KindVolume:
		return l.opts.Docker.RemoveVolume(ctx, it.ID)
	case KindNetwork:
		return l.opts.Docker.RemoveNetwork(ctx, it.ID)
	case KindData:
		// Only ever a services/<id> folder of our own layout.
		want, err := l.opts.Layout.ServiceDir(it.Name)
		if err != nil || want != it.ID {
			return fmt.Errorf("refusing to delete %s", it.ID)
		}
		return os.RemoveAll(it.ID)
	}
	return fmt.Errorf("unknown item kind %q", it.Kind)
}
