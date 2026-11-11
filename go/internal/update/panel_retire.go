package update

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"path/filepath"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// panelRetire is the journal of the panel retired on this node (the old
// panel node of a move). It stays until RemoveOldPanel: while it exists
// the stopped copy is never started again.
type panelRetire struct {
	MoveID    string      `json:"moveId"`
	ServiceID string      `json:"serviceId"`
	Phase     retirePhase `json:"phase"`
	At        time.Time   `json:"at"`
}

type retirePhase string

const (
	// retiring: RetirePanel answered; the panel may still run.
	retiring retirePhase = "retiring"
	// retired: the panel is stopped.
	retired retirePhase = "retired"
)

// Retire answers, then stops the panel running on this node in the
// background (its container and data folder stay, stopped): the old
// panel's last call. The journal is written first, so an agent restart
// right after the answer still finishes the stop. A panel retired here
// already answers again without anything changing: the moved panel calls
// too, and by then its desired state may have taken the spec away.
func (m *PanelMover) Retire(ctx context.Context, req *agentv1.RetirePanelRequest) error {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return err
	}
	if req.GetServiceId() != m.opts.PanelServiceID {
		return invalidMove("service %s is not the protected panel service", req.GetServiceId())
	}
	release, ok := m.lock.TryAcquire(holdPanelRetire)
	if !ok {
		return busyMove(m.lock.Holder())
	}
	if _, spec, err := m.opts.Runtime.spec(ctx, req.GetServiceId()); err != nil || spec.GetStopped() {
		list, lerr := m.panelContainers(ctx)
		switch {
		case lerr == nil && !anyRunning(list) && m.retiredHere(id, req.GetServiceId()):
			release()
			m.opts.Logger.Info("panel move: the old panel is stopped here already", "move_id", id)
			return nil
		case err != nil && (lerr != nil || !anyRunning(list)):
			release()
			return refusedMove(ReasonNoPanel, "the panel does not run on this node")
		}
	}
	r := &panelRetire{MoveID: id, ServiceID: req.GetServiceId(), Phase: retiring, At: m.opts.Now().UTC()}
	if err := writeJSON(m.retireFile(), r); err != nil {
		release()
		return failedMove(ReasonStart, fmt.Errorf("writing the retire journal: %w", err))
	}
	m.opts.Logger.Warn("panel move: the panel moved to another node; stopping it here", "move_id", id)
	go func() {
		defer release()
		bg := m.bg.get()
		if !sleepCtx(bg, retireDelay) {
			return
		}
		m.retire(bg, r)
	}()
	return nil
}

// retire stops the panel and records it. A stop that fails is tried again
// until it works, backing off to a minute: an old panel that kept running
// next to the moved one would take nodes back. The journal stays, so an
// agent restart tries too.
func (m *PanelMover) retire(ctx context.Context, r *panelRetire) {
	wait := retryRetire
	for attempt := 1; ; attempt++ {
		err := m.stopPanel(ctx, r.ServiceID)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			m.opts.Logger.Warn("panel move: the agent is stopping before the old panel stopped; the next start finishes it", "move_id", r.MoveID)
			return
		}
		m.opts.Logger.Error("panel move: stopping the old panel failed; trying again", "move_id", r.MoveID, "attempt", attempt, "retry_in", wait, "err", err)
		if !sleepCtx(ctx, wait) {
			return
		}
		wait = min(wait*2, time.Minute)
	}
	r.Phase = retired
	if err := writeJSON(m.retireFile(), r); err != nil {
		m.opts.Logger.Error("panel move: writing the retire journal", "err", err)
	}
	m.opts.Logger.Info("panel move: the old panel is stopped; its copy stays here until it is deleted from the panel", "move_id", r.MoveID)
}

// stopPanel stops the panel service through reconcile (stopped stays in
// its spec). When the spec has gone already (the moved panel sent this
// node its desired state), reconcile leaves the protected container
// alone, so its containers are stopped directly.
func (m *PanelMover) stopPanel(ctx context.Context, serviceID string) error {
	err := m.opts.Runtime.Stop(ctx, serviceID)
	if err == nil {
		return nil
	}
	if _, _, specErr := m.opts.Runtime.spec(ctx, serviceID); specErr == nil {
		return err
	}
	if m.opts.Host.StopContainer == nil {
		return ErrRuntimeNotReady
	}
	list, lerr := m.panelContainers(ctx)
	if lerr != nil {
		return lerr
	}
	for _, c := range list {
		if c.Running {
			if err := m.opts.Host.StopContainer(ctx, c.ID); err != nil {
				return fmt.Errorf("stopping %s: %w", c.Name, err)
			}
		}
	}
	return nil
}

// resumeRetire finishes a retire the agent stopped in, and keeps a
// retired panel stopped should its spec say otherwise. The stop runs in
// the background like Retire's: it retries until it works.
func (m *PanelMover) resumeRetire(ctx context.Context) error {
	var r panelRetire
	if err := readJSON(m.retireFile(), &r); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("reading the retire journal: %w", err)
	}
	switch r.Phase {
	case retiring:
		m.opts.Logger.Warn("panel move: finishing the stop of the old panel", "move_id", r.MoveID)
	case retired:
		_, spec, err := m.opts.Runtime.spec(ctx, r.ServiceID)
		if err != nil || spec.GetStopped() {
			return nil
		}
		m.opts.Logger.Warn("panel move: the old panel's spec here is not stopped; stopping it", "move_id", r.MoveID)
	default:
		return nil
	}
	release, ok := m.lock.TryAcquire(holdPanelRetire)
	if !ok {
		return ErrBusy
	}
	go func() {
		defer release()
		m.retire(ctx, &r)
	}()
	return nil
}

// retiredHere reports whether the retire journal is serviceID's and says
// the panel was retired, or is retiring for move id.
func (m *PanelMover) retiredHere(id, serviceID string) bool {
	var r panelRetire
	if err := readJSON(m.retireFile(), &r); err != nil {
		return false
	}
	return r.ServiceID == serviceID && (r.Phase == retired || r.MoveID == id)
}

// Retired returns the move that retired the panel copy on this node.
func (m *PanelMover) Retired() (moveID string, ok bool) {
	var r panelRetire
	if err := readJSON(m.retireFile(), &r); err != nil {
		return "", false
	}
	return r.MoveID, true
}

// RemoveOld deletes the copy a move left on this node: the stopped panel
// container, the panel's data folder (master.key, panel.db, the agents'
// TLS key), the panel update snapshots, the registry storage and what
// earlier moves staged or set aside. Refused where the panel runs.
func (m *PanelMover) RemoveOld(ctx context.Context, req *agentv1.RemoveOldPanelRequest) (*agentv1.RemoveOldPanelResponse, error) {
	if req.GetServiceId() != m.opts.PanelServiceID {
		return nil, invalidMove("service %s is not the protected panel service", req.GetServiceId())
	}
	if u, err := url.Parse(m.opts.PanelURL()); err == nil && u.Host != "" && loopback(u.Hostname()) {
		return nil, refusedMove(ReasonPanelHere, "the agent on this node connects to its panel on this machine: the panel runs here")
	}
	release, ok := m.lock.TryAcquire(holdOldPanel)
	if !ok {
		return nil, busyMove(m.lock.Holder())
	}
	defer release()
	if exists(m.journal()) {
		return nil, refusedMove(ReasonMoveUnfinished, "a panel move to this node is not finished")
	}
	list, err := m.panelContainers(ctx)
	if err != nil {
		return nil, failedMove(ReasonPanelHere, err)
	}
	if anyRunning(list) {
		return nil, refusedMove(ReasonPanelHere, "a panel runs on this node")
	}
	if _, spec, err := m.opts.Runtime.spec(ctx, req.GetServiceId()); err == nil {
		if !spec.GetStopped() {
			return nil, refusedMove(ReasonPanelHere, "this node's desired state runs the panel here")
		}
		if err := m.opts.Runtime.Uninstall(ctx, req.GetServiceId()); err != nil {
			return nil, failedMove(ReasonPanelHere, err)
		}
	}
	for _, c := range list {
		if err := m.removeContainer(ctx, c.ID); err != nil {
			return nil, failedMove(ReasonPanelHere, fmt.Errorf("removing the stopped panel container %s: %w", c.Name, err))
		}
	}
	if m.opts.Host.RemoveRegistry != nil {
		if err := m.opts.Host.RemoveRegistry(ctx); err != nil {
			return nil, failedMove(ReasonPanelHere, fmt.Errorf("removing the registry container: %w", err))
		}
	}
	paths := []string{
		m.panelDir(),
		filepath.Join(updateDir(m.root()), panelSnaps),
		m.registryDir(),
		filepath.Join(m.root(), panelIncoming),
		filepath.Join(m.root(), registryIncoming),
	}
	for _, pattern := range []string{panelBefore + "*", registryBefore + "*"} {
		matches, _ := filepath.Glob(filepath.Join(m.root(), pattern))
		paths = append(paths, matches...)
	}
	var freed uint64
	var errs []error
	for _, p := range paths {
		n := usage(p)
		if err := secureRemoveAll(p); err != nil {
			errs = append(errs, err)
			continue
		}
		freed += n
	}
	if len(errs) > 0 {
		return nil, failedMove(ReasonPanelHere, fmt.Errorf("deleting the old copy: %w", errors.Join(errs...)))
	}
	_ = removeIfExists(m.retireFile())
	m.opts.Logger.Info("panel move: deleted the old copy of the panel", "freed_bytes", freed)
	return &agentv1.RemoveOldPanelResponse{FreedBytes: freed}, nil
}

// usage is the bytes of the regular files under path (links not followed).
func usage(path string) uint64 {
	var n uint64
	_ = filepath.WalkDir(path, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				n += uint64(info.Size())
			}
		}
		return nil
	})
	return n
}

func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
