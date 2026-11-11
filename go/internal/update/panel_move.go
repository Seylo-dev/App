package update

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

// Moving the panel to another node (panel.relocate.v1, panel_move.proto).
// The old panel coordinates every step through the agents, with its writes
// paused; this file is the agents' part.
//
// On the target: ImportPanelData and ImportRegistry unpack into staging
// folders (<root>/panel-incoming/<move>, <root>/registry-incoming/<move>),
// never into the live ones. StartMovedPanel sets the live folders aside
// (panel-before-<move>, registry-before-<move>), renames the staged ones
// into place, records the spec the moved panel will send in the desired
// state and waits until that panel is healthy, presents the agents' TLS
// key nodes pin and answers with the expected version. A journal
// (update/panel-move.json) records each step before it happens, so a
// failed start, AbortMovedPanel or an agent restart puts everything back:
// a half-started panel is never left behind. The moved panel then waits
// on standby (it answers agents with 503) until CommitMovedPanel, the
// switch: the journal records it, then the marker file move-commit in the
// panel's data folder tells the panel to take agents. Nothing undoes a
// committed move, and this node's agent dials the moved panel (its staged
// loopback address) only after it. Once that agent reaches the moved
// panel (Arrived), the move is over here and the journal goes.
//
// On the old panel node: RetirePanel answers, then stops the panel (its
// container and data folder stay, stopped); a journal (panel-retire.json)
// finishes the stop after a restart and keeps `seylo panel start` from
// starting that copy again. RemoveOldPanel deletes the copy once the
// owner confirms the move.

// Holders of the update lock during a move. They start with
// holdPanelUpdate, so agent self-updates wait for them and reboots and
// Docker updates are refused meanwhile.
const (
	holdPanelMove   = holdPanelUpdate + " (move)"
	holdPanelRetire = holdPanelUpdate + " (retire)"
	holdOldPanel    = holdPanelUpdate + " (old copy)"
)

// Files and folders of a move.
const (
	moveJournal      = "panel-move.json"   // under update/
	retireJournal    = "panel-retire.json" // under update/
	panelIncoming    = "panel-incoming"
	registryIncoming = "registry-incoming"
	panelBefore      = "panel-before-"
	registryBefore   = "registry-before-"
	// commitMarker is the switch marker in the moved panel's data folder:
	// it holds the move id once CommitMovedPanel committed that move. The
	// panel stops refusing agents when it sees it.
	commitMarker = "move-commit"
)

// Timing and sizes. Variables so tests can change them.
var (
	// DefaultMoveHealthTimeout applies when StartMovedPanel sets none.
	DefaultMoveHealthTimeout = 3 * time.Minute
	// maxMoveHealthTimeout is the longest health wait a request may ask for.
	maxMoveHealthTimeout = 30 * time.Minute
	// moveCheckWait bounds the pin and version checks after the health check.
	moveCheckWait = 30 * time.Second
	// moveCheckPoll is the pause between those checks.
	moveCheckPoll = 500 * time.Millisecond
	// moveAbortWait is how long AbortMovedPanel waits for a step of the
	// move that is still running.
	moveAbortWait = 2 * time.Minute
	// moveCommitWait is how long CommitMovedPanel waits for the update
	// lock, inside the old panel's 30 s call timeout; a busy answer is
	// tried again.
	moveCommitWait = 20 * time.Second
	// moveUndoTimeout bounds putting things back after a failed start.
	moveUndoTimeout = 2 * time.Minute
	// moveReserve is the space an import leaves free on top of what it needs.
	moveReserve uint64 = 64 << 20
	// retireDelay lets RetirePanel's answer reach the panel before the
	// panel stops.
	retireDelay = time.Second
	// retryRetire is the pause between attempts to stop a retired panel.
	retryRetire = 15 * time.Second
	// maxManifestFiles caps ImportPanelData's manifest.
	maxManifestFiles = 200000
)

// defaultPanelServiceID is docker.PanelServiceID (the wiring sets it).
const defaultPanelServiceID = "panel00000000000"

// Reasons a step of a move fails. The agent sends them in the status
// details ("reason"), so the panel names the cause without reading the
// message.
const (
	ReasonBadRequest     = "badRequest"
	ReasonBusy           = "busy"
	ReasonPanelRunning   = "panelRunning"
	ReasonPanelHere      = "panelHere"
	ReasonNoPanel        = "noPanel"
	ReasonMoveUnfinished = "moveUnfinished"
	ReasonNotImported    = "notImported"
	ReasonNoSpace        = "noSpace"
	ReasonManifest       = "manifest"
	ReasonBadArchive     = "badArchive"
	ReasonPull           = "pull"
	ReasonStart          = "start"
	ReasonHealth         = "health"
	ReasonPin            = "pin"
	ReasonVersion        = "version"
	ReasonUndo           = "undo"
	ReasonCancelled      = "cancelled"
	// ReasonNotStarted refuses CommitMovedPanel: no healthy moved panel of
	// that move runs here, so nothing switched and the move can be aborted.
	ReasonNotStarted = "notStarted"
	// ReasonCommitted refuses AbortMovedPanel after CommitMovedPanel.
	ReasonCommitted = "committed"
	// ReasonCommit is a CommitMovedPanel that failed for a reason that may
	// pass (the journal or the marker could not be written, Docker did not
	// answer): the old panel tries again.
	ReasonCommit = "commit"
)

// MoveError is a refused or failed step of a move: the status code the
// agent answers with and a Reason.
type MoveError struct {
	Code   agentv1.StatusCode
	Reason string
	Err    error
}

func (e *MoveError) Error() string { return e.Err.Error() }
func (e *MoveError) Unwrap() error { return e.Err }

func moveErr(code agentv1.StatusCode, reason, format string, args ...any) *MoveError {
	return &MoveError{Code: code, Reason: reason, Err: fmt.Errorf(format, args...)}
}

func invalidMove(format string, args ...any) *MoveError {
	return moveErr(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, ReasonBadRequest, format, args...)
}

func refusedMove(reason, format string, args ...any) *MoveError {
	return moveErr(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, reason, format, args...)
}

func failedMove(reason string, err error) *MoveError {
	if me := (*MoveError)(nil); errors.As(err, &me) {
		return me
	}
	code := agentv1.StatusCode_STATUS_CODE_UNAVAILABLE
	switch {
	case errors.Is(err, context.Canceled):
		code = agentv1.StatusCode_STATUS_CODE_CANCELLED
	case errors.Is(err, context.DeadlineExceeded):
		code = agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED
	}
	return &MoveError{Code: code, Reason: reason, Err: err}
}

func busyMove(holder string) *MoveError {
	return &MoveError{Code: agentv1.StatusCode_STATUS_CODE_ABORTED, Reason: ReasonBusy, Err: busy(holder)}
}

// moveIDRe is the form of the panel's ids (16 of [0-9a-z]); a move id
// becomes a folder name.
var moveIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ValidMoveID reports whether id can name a move.
func ValidMoveID(id string) bool { return moveIDRe.MatchString(id) }

func checkMoveID(id string) error {
	if !ValidMoveID(id) {
		return invalidMove("move_id %q is not a move id", id)
	}
	return nil
}

// PanelContainer is one container of the panel service on this node.
type PanelContainer struct {
	ID, Name string
	// Running is anything but created, exited or dead.
	Running bool
}

// MoveHost is what a move needs from Docker on this node. Function fields
// keep this package free of the agent's types; a nil field answers
// ErrRuntimeNotReady.
type MoveHost struct {
	// PanelContainers lists the panel service's containers here, running or not.
	PanelContainers func(ctx context.Context) ([]PanelContainer, error)
	// StopContainer stops a container and keeps it.
	StopContainer func(ctx context.Context, id string) error
	// RemoveContainer stops and removes a container.
	RemoveContainer func(ctx context.Context, id string) error
	// StopRegistry stops the image registry's container, when there is one.
	StopRegistry func(ctx context.Context) error
	// RemoveRegistry removes the image registry's container, when there is one.
	RemoveRegistry func(ctx context.Context) error
}

// MoveOptions configures a PanelMover.
type MoveOptions struct {
	DataDir string
	// Runtime runs the panel service through reconcile.
	Runtime *ReconcileRuntime
	Host    MoveHost
	// PanelServiceID is the protected panel service (docker.PanelServiceID).
	PanelServiceID string
	// PanelURL returns the address this agent dials its panel at now.
	PanelURL func() string
	Logger   *slog.Logger
	Now      func() time.Time
	// Free returns the bytes free at a path; default statfs.
	Free func(path string) (uint64, bool)
	// CheckTLS dials addr over TLS and checks the server key's pin;
	// default a TLS dial with conn.PinnedTLSConfig.
	CheckTLS func(ctx context.Context, addr string, pin []byte) error
	// Health reads the panel's /api/health at url and returns its version;
	// default an HTTP GET.
	Health func(ctx context.Context, url string) (string, error)
}

// PanelMover runs this node's part of moving the panel to another node.
type PanelMover struct {
	opts MoveOptions
	lock *Lock
	// bg is the agent's lifetime: a retire outlives its RPC.
	bg background

	mu sync.Mutex
	// stepMove and stepCancel are the move step holding the lock now
	// (an import or a start), so AbortMovedPanel can stop it.
	stepMove   string
	stepCancel context.CancelFunc
}

// NewPanelMover fills defaults.
func NewPanelMover(opts MoveOptions, lock *Lock) *PanelMover {
	if lock == nil {
		lock = &Lock{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.PanelServiceID == "" {
		opts.PanelServiceID = defaultPanelServiceID
	}
	if opts.PanelURL == nil {
		opts.PanelURL = func() string { return "" }
	}
	if opts.Free == nil {
		opts.Free = freeBytes
	}
	if opts.CheckTLS == nil {
		opts.CheckTLS = checkTLSPin
	}
	if opts.Health == nil {
		opts.Health = panelHealth
	}
	if opts.Runtime == nil {
		opts.Runtime = &ReconcileRuntime{}
	}
	return &PanelMover{opts: opts, lock: lock}
}

// SetBackground sets the context a retire runs under (the agent's lifetime).
func (m *PanelMover) SetBackground(ctx context.Context) { m.bg.set(ctx) }

func (m *PanelMover) root() string        { return m.opts.DataDir }
func (m *PanelMover) panelDir() string    { return filepath.Join(m.root(), "panel") }
func (m *PanelMover) registryDir() string { return filepath.Join(m.root(), "registry") }
func (m *PanelMover) incoming(id string) string {
	return filepath.Join(m.root(), panelIncoming, id)
}
func (m *PanelMover) incomingRecord(id string) string {
	return filepath.Join(m.root(), panelIncoming, id+".json")
}
func (m *PanelMover) registryIncoming(id string) string {
	return filepath.Join(m.root(), registryIncoming, id)
}
func (m *PanelMover) panelAside(id string) string {
	return filepath.Join(m.root(), panelBefore+id)
}
func (m *PanelMover) registryAside(id string) string {
	return filepath.Join(m.root(), registryBefore+id)
}
func (m *PanelMover) marker() string     { return filepath.Join(m.panelDir(), commitMarker) }
func (m *PanelMover) journal() string    { return filepath.Join(updateDir(m.root()), moveJournal) }
func (m *PanelMover) retireFile() string { return filepath.Join(updateDir(m.root()), retireJournal) }

// panelMove is the journal of a moved panel started on this node. Every
// flag is written before the step it names, so undo can always tell what
// to put back; the folder ids tell a folder this move renamed into place
// from one that was there before.
type panelMove struct {
	MoveID       string    `json:"moveId"`
	ServiceID    string    `json:"serviceId"`
	Phase        movePhase `json:"phase"`
	AgentTLSPort uint32    `json:"agentTlsPort"`
	HostPort     uint32    `json:"hostPort"`
	Version      string    `json:"version"`
	// Spec is the marshalled ServiceSpec recorded in the desired state.
	Spec []byte `json:"spec"`
	// AsideRetired: the panel folder set aside was this panel's own copy,
	// retired here by an earlier move (panel-retire.json existed).
	AsideRetired bool `json:"asideRetired,omitempty"`
	// RegistryAside, RegistryIn, PanelAside and PanelIn: the live folder
	// was (to be) moved aside, the staged one (to be) moved in.
	RegistryAside bool      `json:"registryAside,omitempty"`
	RegistryIn    bool      `json:"registryIn,omitempty"`
	RegistryID    fileID    `json:"registryId"`
	PanelAside    bool      `json:"panelAside,omitempty"`
	PanelIn       bool      `json:"panelIn,omitempty"`
	PanelID       fileID    `json:"panelId"`
	StartedAt     time.Time `json:"startedAt"`
}

type movePhase string

const (
	// moveActivating: folders are being swapped; nothing runs yet.
	moveActivating movePhase = "activating"
	// moveStarting: the spec is in the desired state, the panel starts.
	moveStarting movePhase = "starting"
	// moveHealthy: StartMovedPanel succeeded; the panel waits for the
	// switch (or an abort).
	moveHealthy movePhase = "healthy"
	// moveCommitted: CommitMovedPanel switched to the moved panel. Nothing
	// undoes it; the journal waits for this node's agent to reach it.
	moveCommitted movePhase = "committed"
)

func (m *PanelMover) readJournal() (*panelMove, error) {
	var j panelMove
	if err := readJSON(m.journal(), &j); err != nil {
		return nil, err
	}
	return &j, nil
}

func (m *PanelMover) writeJournal(j *panelMove) error {
	if err := writeJSON(m.journal(), j); err != nil {
		return fmt.Errorf("writing the panel move journal: %w", err)
	}
	return nil
}

// beginStep records the step that holds the lock for move id, so an
// abort can cancel it; the returned function ends it.
func (m *PanelMover) beginStep(ctx context.Context, id string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.stepMove, m.stepCancel = id, cancel
	m.mu.Unlock()
	return ctx, func() {
		m.mu.Lock()
		if m.stepMove == id {
			m.stepMove, m.stepCancel = "", nil
		}
		m.mu.Unlock()
		cancel()
	}
}

func (m *PanelMover) cancelStep(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stepMove == id && m.stepCancel != nil {
		m.stepCancel()
	}
}

// panelContainers lists the panel's containers; a missing Docker hook is
// ErrRuntimeNotReady.
func (m *PanelMover) panelContainers(ctx context.Context) ([]PanelContainer, error) {
	if m.opts.Host.PanelContainers == nil {
		return nil, ErrRuntimeNotReady
	}
	list, err := m.opts.Host.PanelContainers(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing the panel's containers: %w", err)
	}
	return list, nil
}

// refuseRunningPanel refuses a step while a panel container runs here:
// writing panel data next to a live panel, or starting a second one, is
// never safe.
func (m *PanelMover) refuseRunningPanel(ctx context.Context) error {
	list, err := m.panelContainers(ctx)
	if err != nil {
		return failedMove(ReasonPanelRunning, err)
	}
	for _, c := range list {
		if c.Running {
			return refusedMove(ReasonPanelRunning, "a panel runs on this node (container %s)", c.Name)
		}
	}
	return nil
}

// settleOtherMove clears what an earlier move to this node left (its
// panel no longer runs: refuseRunningPanel ran first). A journal of the
// same move means it was started already.
func (m *PanelMover) settleOtherMove(ctx context.Context, id string) error {
	j, err := m.readJournal()
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return refusedMove(ReasonMoveUnfinished, "the journal of an earlier panel move cannot be read (%v); remove %s once nothing of that move runs", err, m.journal())
	case j.MoveID == id:
		return refusedMove(ReasonMoveUnfinished, "move %s was started on this node already; abort it first", id)
	case j.Phase == moveCommitted:
		// The panel switched to that copy: it is the panel now, never undone.
		return refusedMove(ReasonMoveUnfinished, "move %s switched the panel to this node and this node's agent has not reached it yet", j.MoveID)
	}
	m.opts.Logger.Warn("panel move: undoing an earlier move to this node that never finished", "move_id", j.MoveID, "phase", j.Phase)
	if err := m.undo(ctx, j); err != nil {
		return failedMove(ReasonMoveUnfinished, fmt.Errorf("undoing the earlier move %s: %w", j.MoveID, err))
	}
	return nil
}

// Start starts the panel staged for req.move_id on this node and answers
// once it is healthy and proven to be the moved panel. Any failure puts
// everything back before it answers.
func (m *PanelMover) Start(ctx context.Context, req *agentv1.StartMovedPanelRequest) (*agentv1.StartMovedPanelResponse, error) {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return nil, err
	}
	spec := req.GetSpec()
	switch {
	case spec == nil:
		return nil, invalidMove("no panel spec")
	case spec.GetId() != m.opts.PanelServiceID || !spec.GetProtected():
		return nil, invalidMove("service %s is not the protected panel service", spec.GetId())
	case spec.GetStopped():
		return nil, invalidMove("the panel spec is stopped")
	case spec.GetImage().GetReference() == "":
		return nil, invalidMove("the panel spec names no image")
	}
	pin, err := conn.ParsePin(req.GetPanelPin())
	if err != nil {
		return nil, invalidMove("panel_pin: %v", err)
	}
	tlsPort, hostPort := req.GetAgentTlsPort(), req.GetHostPort()
	if tlsPort == 0 || tlsPort > 65535 || hostPort == 0 || hostPort > 65535 || tlsPort == hostPort {
		return nil, invalidMove("agent_tls_port %d and host_port %d must be two different ports", tlsPort, hostPort)
	}
	if req.GetExpectedVersion() == "" {
		return nil, invalidMove("expected_version is required")
	}
	timeout := req.GetHealthTimeout().AsDuration()
	if timeout <= 0 {
		timeout = DefaultMoveHealthTimeout
	}
	if timeout > maxMoveHealthTimeout {
		return nil, invalidMove("health_timeout %s is longer than %s", timeout, maxMoveHealthTimeout)
	}

	release, ok := m.lock.TryAcquire(holdPanelMove)
	if !ok {
		return nil, busyMove(m.lock.Holder())
	}
	defer release()
	ctx, end := m.beginStep(ctx, id)
	defer end()

	if j, err := m.readJournal(); err == nil && j.MoveID == id && (j.Phase == moveHealthy || j.Phase == moveCommitted) {
		// A retried call: answer again once the panel still runs.
		if list, err := m.panelContainers(ctx); err == nil && anyRunning(list) {
			return &agentv1.StartMovedPanelResponse{Version: j.Version}, nil
		}
	}
	if err := m.refuseRunningPanel(ctx); err != nil {
		return nil, err
	}
	if err := m.settleOtherMove(ctx, id); err != nil {
		return nil, err
	}
	rec, err := m.readImported(id)
	if err != nil {
		return nil, err
	}
	regStaged := isDir(m.registryIncoming(id))

	// The image first: nothing is touched until it is here.
	if err := m.opts.Runtime.Pull(ctx, spec.GetImage()); err != nil {
		m.dropStaging(id)
		return nil, failedMove(ReasonPull, fmt.Errorf("pulling %s: %w", spec.GetImage().GetReference(), err))
	}
	specBytes, err := proto.Marshal(spec)
	if err != nil {
		return nil, invalidMove("encoding the spec: %v", err)
	}
	j := &panelMove{
		MoveID: id, ServiceID: spec.GetId(), Phase: moveActivating,
		AgentTLSPort: tlsPort, HostPort: hostPort, Spec: specBytes,
		AsideRetired: exists(m.retireFile()),
		StartedAt:    m.opts.Now().UTC(),
	}
	if err := m.writeJournal(j); err != nil {
		m.dropStaging(id)
		return nil, failedMove(ReasonStart, err)
	}
	version, err := m.activate(ctx, j, spec, rec, regStaged, pin, req.GetExpectedVersion(), timeout)
	if err != nil {
		m.opts.Logger.Error("panel move: the moved panel did not start; putting everything back", "move_id", id, "err", err)
		uctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), moveUndoTimeout)
		defer cancel()
		if uerr := m.undo(uctx, j); uerr != nil {
			m.opts.Logger.Error("panel move: putting things back failed; the next agent start tries again", "move_id", id, "err", uerr)
			me := failedMove(ReasonStart, err)
			me.Err = errors.Join(me.Err, fmt.Errorf("putting things back: %w", uerr))
			return nil, me
		}
		return nil, err
	}
	m.opts.Logger.Info("panel move: the moved panel runs here and waits for the switch", "move_id", id, "version", version)
	return &agentv1.StartMovedPanelResponse{Version: version}, nil
}

// activate swaps the folders, records the spec, waits for health and
// checks the panel. j is rewritten before every step.
func (m *PanelMover) activate(ctx context.Context, j *panelMove, spec *agentv1.ServiceSpec, rec *importedPanel, regStaged bool, pin []byte, wantVersion string, timeout time.Duration) (string, error) {
	// Stopped panel containers here are copies an earlier move left: a
	// failed start in RECREATE mode would start them again, on the data
	// that moved in.
	list, err := m.panelContainers(ctx)
	if err != nil {
		return "", failedMove(ReasonStart, err)
	}
	for _, c := range list {
		if c.Running {
			return "", refusedMove(ReasonPanelRunning, "a panel runs on this node (container %s)", c.Name)
		}
		if err := m.removeContainer(ctx, c.ID); err != nil {
			return "", failedMove(ReasonStart, fmt.Errorf("removing the stopped panel container %s: %w", c.Name, err))
		}
	}

	// The registry this node may have (it ran the panel once) goes aside
	// whether or not one moved: the moved panel finds the old node's images,
	// or none, never older ones.
	if exists(m.registryDir()) {
		if err := m.stopRegistry(ctx); err != nil {
			return "", failedMove(ReasonStart, fmt.Errorf("stopping the registry: %w", err))
		}
		j.RegistryAside = true
		if err := m.writeJournal(j); err != nil {
			return "", failedMove(ReasonStart, err)
		}
		if err := os.Rename(m.registryDir(), m.registryAside(j.MoveID)); err != nil {
			return "", failedMove(ReasonStart, fmt.Errorf("setting the registry storage aside: %w", err))
		}
	}
	if regStaged {
		j.RegistryIn, j.RegistryID = true, mustID(m.registryIncoming(j.MoveID))
		if err := m.writeJournal(j); err != nil {
			return "", failedMove(ReasonStart, err)
		}
		if err := os.Rename(m.registryIncoming(j.MoveID), m.registryDir()); err != nil {
			return "", failedMove(ReasonStart, fmt.Errorf("moving the registry storage into place: %w", err))
		}
	}
	if exists(m.panelDir()) {
		j.PanelAside = true
		if err := m.writeJournal(j); err != nil {
			return "", failedMove(ReasonStart, err)
		}
		if err := os.Rename(m.panelDir(), m.panelAside(j.MoveID)); err != nil {
			return "", failedMove(ReasonStart, fmt.Errorf("setting the panel folder aside: %w", err))
		}
	}
	j.PanelIn, j.PanelID = true, mustID(m.incoming(j.MoveID))
	if err := m.writeJournal(j); err != nil {
		return "", failedMove(ReasonStart, err)
	}
	if err := os.Rename(m.incoming(j.MoveID), m.panelDir()); err != nil {
		return "", failedMove(ReasonStart, fmt.Errorf("moving the panel's data into place: %w", err))
	}
	_ = removeIfExists(m.incomingRecord(j.MoveID))
	// The staging parents go once empty.
	_ = os.Remove(filepath.Join(m.root(), panelIncoming))
	_ = os.Remove(filepath.Join(m.root(), registryIncoming))
	if err := os.Chmod(m.panelDir(), 0o700); err != nil {
		return "", failedMove(ReasonStart, err)
	}
	if err := removeStrayDBFiles(m.panelDir(), rec); err != nil {
		return "", failedMove(ReasonStart, err)
	}

	j.Phase = moveStarting
	if err := m.writeJournal(j); err != nil {
		return "", failedMove(ReasonStart, err)
	}
	if err := m.opts.Runtime.Install(ctx, spec); err != nil {
		return "", failedMove(ReasonStart, fmt.Errorf("recording the panel in this node's desired state: %w", err))
	}
	if err := m.opts.Runtime.WaitHealthy(ctx, spec.GetId(), timeout); err != nil {
		return "", failedMove(ReasonHealth, fmt.Errorf("the moved panel did not become healthy: %w", err))
	}
	version, err := m.checkStarted(ctx, j, pin, wantVersion)
	if err != nil {
		return "", err
	}
	j.Phase, j.Version = moveHealthy, version
	if err := m.writeJournal(j); err != nil {
		return "", failedMove(ReasonStart, err)
	}
	return version, nil
}

// checkStarted makes sure the panel that came up is the one that moved:
// its agents' TLS port presents the key every node pins (a panel that
// found no agent-tls.key makes a new one, and every node would refuse
// it), and /api/health answers with the expected version.
func (m *PanelMover) checkStarted(ctx context.Context, j *panelMove, pin []byte, want string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, moveCheckWait)
	defer cancel()
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(int(j.AgentTLSPort)))
	for {
		err := m.opts.CheckTLS(ctx, addr, pin)
		if err == nil {
			break
		}
		if errors.Is(err, conn.ErrPinMismatch) {
			return "", refusedMove(ReasonPin, "the moved panel presents another agents' TLS key on port %d than the one nodes pin: its agent-tls.key did not arrive", j.AgentTLSPort)
		}
		if !sleepCtx(ctx, moveCheckPoll) {
			return "", failedMove(ReasonPin, fmt.Errorf("the moved panel's agents' TLS port %d does not answer: %w", j.AgentTLSPort, err))
		}
	}
	healthURL := "http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(int(j.HostPort))) + "/api/health"
	for {
		version, err := m.opts.Health(ctx, healthURL)
		if err == nil {
			if version != want {
				return "", refusedMove(ReasonVersion, "the moved panel runs version %s, not %s", version, want)
			}
			return version, nil
		}
		if !sleepCtx(ctx, moveCheckPoll) {
			return "", failedMove(ReasonHealth, fmt.Errorf("the moved panel's %s does not answer: %w", healthURL, err))
		}
	}
}

// Abort undoes move req.move_id on this node at whatever step before the
// switch it is: the panel it started goes, the folders it set aside come
// back and the staged copies (master.key and the agents' TLS key among
// them) are deleted. Without a journal of that move only its staging can
// exist. A committed move is refused: the moved panel may hold nodes.
func (m *PanelMover) Abort(ctx context.Context, req *agentv1.AbortMovedPanelRequest) error {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return err
	}
	// A step of this move still running (an import, a start) stops first.
	m.cancelStep(id)
	release, holder, ok := m.lock.AcquireWithin(ctx, holdPanelMove, moveAbortWait, panelSwapHolds)
	if !ok {
		return busyMove(holder)
	}
	defer release()
	j, err := m.readJournal()
	switch {
	case err == nil && j.MoveID == id && j.Phase == moveCommitted,
		errors.Is(err, fs.ErrNotExist) && m.committed(id):
		// The switch happened (without a journal: and this agent reached
		// the moved panel since). The moved panel is the panel now.
		return refusedMove(ReasonCommitted, "move %s was committed: the moved panel on this node is the panel now", id)
	case err == nil && j.MoveID == id && j.Phase == moveHealthy && m.servesHere(j):
		// This agent reached the moved panel at its staged address: it is
		// the panel in use now, and an abort from anywhere must not stop it.
		m.finish(j)
		return refusedMove(ReasonPanelHere, "move %s is over: the moved panel runs on this node and is in use", id)
	case err == nil && j.MoveID == id:
		if err := m.undo(ctx, j); err != nil {
			return failedMove(ReasonUndo, err)
		}
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		m.opts.Logger.Warn("panel move: the move journal cannot be read", "err", err)
	}
	m.dropStaging(id)
	return nil
}

// undo puts back what j records. It stops at the first step that fails,
// so it never deletes a folder a panel may still use, and keeps the
// journal then; running it again continues from there.
func (m *PanelMover) undo(ctx context.Context, j *panelMove) error {
	if j.Phase == moveCommitted {
		return fmt.Errorf("move %s was committed: the moved panel is the panel and is never undone", j.MoveID)
	}
	if j.Phase != moveActivating {
		// Out of the desired state first, so reconcile does not start it
		// again, then every panel container here: none ran before the move.
		if err := m.opts.Runtime.Uninstall(ctx, j.ServiceID); err != nil {
			return fmt.Errorf("removing the moved panel from the desired state: %w", err)
		}
		list, err := m.panelContainers(ctx)
		if err != nil {
			return err
		}
		for _, c := range list {
			if err := m.removeContainer(ctx, c.ID); err != nil {
				return fmt.Errorf("removing the moved panel's container %s: %w", c.Name, err)
			}
		}
	}
	if j.PanelIn {
		if id, ok := idOf(m.panelDir()); ok && id == j.PanelID {
			if err := secureRemoveAll(m.panelDir()); err != nil {
				return fmt.Errorf("deleting the moved panel's data: %w", err)
			}
		}
		j.PanelIn = false
		if err := m.writeJournal(j); err != nil {
			return err
		}
	}
	if j.PanelAside {
		if err := putBack(m.panelAside(j.MoveID), m.panelDir()); err != nil {
			return fmt.Errorf("putting the panel folder back: %w", err)
		}
		j.PanelAside = false
		if err := m.writeJournal(j); err != nil {
			return err
		}
	}
	if j.RegistryIn || j.RegistryAside {
		if err := m.stopRegistry(ctx); err != nil {
			return fmt.Errorf("stopping the registry: %w", err)
		}
	}
	if j.RegistryIn {
		if id, ok := idOf(m.registryDir()); ok && id == j.RegistryID {
			if err := os.RemoveAll(m.registryDir()); err != nil {
				return fmt.Errorf("deleting the moved registry storage: %w", err)
			}
		}
		j.RegistryIn = false
		if err := m.writeJournal(j); err != nil {
			return err
		}
	}
	if j.RegistryAside {
		if err := putBack(m.registryAside(j.MoveID), m.registryDir()); err != nil {
			return fmt.Errorf("putting the registry storage back: %w", err)
		}
		j.RegistryAside = false
		if err := m.writeJournal(j); err != nil {
			return err
		}
	}
	m.dropStaging(j.MoveID)
	if err := removeIfExists(m.journal()); err != nil {
		return err
	}
	m.opts.Logger.Info("panel move: undone on this node", "move_id", j.MoveID)
	return nil
}

// putBack renames aside back to live; a missing aside folder was never
// moved (or is back already).
func putBack(aside, live string) error {
	if !exists(aside) {
		return nil
	}
	if exists(live) {
		return fmt.Errorf("%s exists, so %s cannot go back there", live, aside)
	}
	return os.Rename(aside, live)
}

// dropStaging deletes what the imports of move id staged.
func (m *PanelMover) dropStaging(id string) {
	if err := secureRemoveAll(m.incoming(id)); err != nil {
		m.opts.Logger.Error("panel move: deleting the staged panel data", "move_id", id, "err", err)
	}
	_ = removeIfExists(m.incomingRecord(id))
	if err := os.RemoveAll(m.registryIncoming(id)); err != nil {
		m.opts.Logger.Error("panel move: deleting the staged registry storage", "move_id", id, "err", err)
	}
	// The parents go once empty.
	_ = os.Remove(filepath.Join(m.root(), panelIncoming))
	_ = os.Remove(filepath.Join(m.root(), registryIncoming))
}

// Arrived is called when this agent reached the panel at the address
// staged for move id: the move is over. On the target that ends the
// journal; a panel folder set aside that was this panel's own retired
// copy goes too (a folder of unknown origin stays for its owner).
func (m *PanelMover) Arrived(id string) {
	go func() {
		ctx := m.bg.get()
		release, _, ok := m.lock.AcquireWithin(ctx, holdPanelMove, time.Minute, panelSwapHolds)
		if !ok {
			m.opts.Logger.Warn("panel move: could not finish the move here; the next agent start does", "move_id", id)
			return
		}
		defer release()
		j, err := m.readJournal()
		if err != nil || j.MoveID != id || (j.Phase != moveCommitted && j.Phase != moveHealthy) {
			return
		}
		m.finish(j)
	}()
}

// Commit is the switch of move req.move_id (CommitMovedPanel): the moved
// panel waiting here takes agents from now on. The journal records it
// first, then the marker file tells the panel; nothing undoes the move
// after that. Refused with notStarted when no healthy moved panel of that
// move runs here, so the old panel knows nothing switched and aborts.
// Calling it again for the same move succeeds.
func (m *PanelMover) Commit(ctx context.Context, req *agentv1.CommitMovedPanelRequest) error {
	id := req.GetMoveId()
	if err := checkMoveID(id); err != nil {
		return err
	}
	release, holder, ok := m.lock.AcquireWithin(ctx, holdPanelMove, moveCommitWait, panelSwapHolds)
	if !ok {
		return busyMove(holder)
	}
	defer release()
	j, err := m.readJournal()
	switch {
	case errors.Is(err, fs.ErrNotExist) && m.committed(id):
		// Committed, and this agent reached the moved panel since.
		return nil
	case errors.Is(err, fs.ErrNotExist):
		return refusedMove(ReasonNotStarted, "no moved panel of move %s waits on this node", id)
	case err != nil:
		return refusedMove(ReasonNotStarted, "the panel move journal cannot be read (%v), so no moved panel of move %s is known here", err, id)
	case j.MoveID != id:
		return refusedMove(ReasonNotStarted, "no moved panel of move %s waits on this node (the journal is move %s's)", id, j.MoveID)
	case j.Phase == moveCommitted:
		// A retried call. An agent that stopped between the journal and
		// the marker wrote no marker.
		if err := m.writeMarker(id); err != nil {
			return failedMove(ReasonCommit, err)
		}
		return nil
	case j.Phase != moveHealthy:
		return refusedMove(ReasonNotStarted, "the moved panel of move %s has not started (%s)", id, j.Phase)
	}
	list, err := m.panelContainers(ctx)
	if err != nil {
		return failedMove(ReasonCommit, err)
	}
	if !anyRunning(list) {
		return refusedMove(ReasonNotStarted, "the moved panel of move %s does not run on this node", id)
	}
	j.Phase = moveCommitted
	if err := m.writeJournal(j); err != nil {
		return failedMove(ReasonCommit, err)
	}
	if err := m.writeMarker(id); err != nil {
		// Without the marker nothing switched: an abort may still undo it.
		j.Phase = moveHealthy
		if jerr := m.writeJournal(j); jerr != nil {
			m.opts.Logger.Error("panel move: the journal stays committed; the next commit writes the marker", "move_id", id, "err", jerr)
		}
		return failedMove(ReasonCommit, err)
	}
	m.opts.Logger.Warn("panel move: committed; the moved panel on this node takes the nodes from now on", "move_id", id)
	return nil
}

// AwaitsCommit reports whether a moved panel of move id waits on this node
// for the switch. Until then this agent must not dial the address staged
// for that move (the moved panel on this machine): it would get there
// before the old panel knows whether the move goes through.
func (m *PanelMover) AwaitsCommit(id string) bool {
	j, err := m.readJournal()
	return err == nil && j.MoveID == id && j.Phase != moveCommitted
}

// committed reports whether the marker in the panel's data folder names
// move id: that move was committed on this node.
func (m *PanelMover) committed(id string) bool {
	b, err := os.ReadFile(m.marker())
	return err == nil && string(b) == id
}

// writeMarker writes the switch marker of move id into the moved panel's
// data folder: through a temp file and a rename, so the panel never reads
// half of it, owned like the folder (the panel user) and 0600.
func (m *PanelMover) writeMarker(id string) error {
	if m.committed(id) {
		return nil
	}
	dir := m.panelDir()
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("the moved panel's data folder: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a folder", dir)
	}
	tmp, err := os.CreateTemp(dir, "."+commitMarker+".tmp-*")
	if err != nil {
		return fmt.Errorf("writing the switch marker: %w", err)
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.WriteString(id)
	if err == nil {
		err = tmp.Chmod(0o600)
	}
	if err == nil {
		chownLike(tmp.Name(), info)
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), m.marker())
	}
	if err != nil {
		return fmt.Errorf("writing the switch marker: %w", err)
	}
	return nil
}

// finish ends a move whose panel this node now serves.
func (m *PanelMover) finish(j *panelMove) {
	if j.AsideRetired {
		if err := secureRemoveAll(m.panelAside(j.MoveID)); err != nil {
			m.opts.Logger.Error("panel move: deleting the earlier copy of the panel", "err", err)
		}
		if err := os.RemoveAll(m.registryAside(j.MoveID)); err != nil {
			m.opts.Logger.Error("panel move: deleting the earlier registry storage", "err", err)
		}
		_ = removeIfExists(m.retireFile())
	} else if j.PanelAside || j.RegistryAside {
		m.opts.Logger.Warn("panel move: the folders that were here before the move stay; delete them when they are not needed",
			"panel", m.panelAside(j.MoveID), "registry", m.registryAside(j.MoveID))
	}
	if err := removeIfExists(m.journal()); err != nil {
		m.opts.Logger.Error("panel move: clearing the journal", "err", err)
	}
	m.opts.Logger.Info("panel move: the panel runs on this node now", "move_id", j.MoveID)
}

// servesHere reports whether this agent dials the panel the move started
// here: https:// on this machine at the move's agents' TLS port.
func (m *PanelMover) servesHere(j *panelMove) bool {
	u, err := url.Parse(m.opts.PanelURL())
	if err != nil || (u.Scheme != "https" && u.Scheme != "wss") || u.Port() != strconv.Itoa(int(j.AgentTLSPort)) {
		return false
	}
	return loopback(u.Hostname())
}

// Resume runs once at agent start. A move journal left before the healthy
// phase is undone: the start never answered, so the panel aborts the move
// anyway, and a half-started panel must not stay. A healthy one waits for
// the panel's switch or abort, a committed one for this agent to reach it
// (with its marker written again, should the agent have stopped before
// that), unless this agent already serves it. A retire still in its first
// phase is finished, unless a moved panel waits here (the retire journal
// is then the old copy's, set aside by the move, and the panel that runs
// is the moved one).
func (m *PanelMover) Resume(ctx context.Context) error {
	waiting, err := m.resumeMove(ctx)
	if err != nil || waiting {
		return err
	}
	return m.resumeRetire(ctx)
}

// resumeMove settles a move journal and reports whether a moved panel
// still waits here for the switch.
func (m *PanelMover) resumeMove(ctx context.Context) (bool, error) {
	release, ok := m.lock.TryAcquire(holdPanelMove)
	if !ok {
		return true, ErrBusy
	}
	defer release()
	j, err := m.readJournal()
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	case err != nil:
		return true, fmt.Errorf("reading the panel move journal: %w", err)
	case j.Phase != moveHealthy && j.Phase != moveCommitted:
		m.opts.Logger.Warn("panel move: the agent restarted while the moved panel started; putting everything back", "move_id", j.MoveID, "phase", j.Phase)
		if err := m.undo(ctx, j); err != nil {
			return true, fmt.Errorf("undoing the interrupted panel move: %w", err)
		}
		return false, nil
	case m.servesHere(j):
		m.finish(j)
		return false, nil
	case j.Phase == moveCommitted:
		if err := m.writeMarker(j.MoveID); err != nil {
			return true, fmt.Errorf("the committed panel move %s: %w", j.MoveID, err)
		}
	}
	return true, nil
}

func (m *PanelMover) removeContainer(ctx context.Context, id string) error {
	if m.opts.Host.RemoveContainer == nil {
		return ErrRuntimeNotReady
	}
	return m.opts.Host.RemoveContainer(ctx, id)
}

func (m *PanelMover) stopRegistry(ctx context.Context) error {
	if m.opts.Host.StopRegistry == nil {
		return ErrRuntimeNotReady
	}
	return m.opts.Host.StopRegistry(ctx)
}

func anyRunning(list []PanelContainer) bool {
	for _, c := range list {
		if c.Running {
			return true
		}
	}
	return false
}

func isDir(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir()
}

func mustID(path string) fileID {
	id, _ := idOf(path)
	return id
}

// secureRemoveAll deletes a folder that may hold the panel's keys: key
// files are overwritten first, so a deleted copy does not leave them
// readable on the disk's free blocks where the filesystem writes in place.
// Links are never followed.
func secureRemoveAll(dir string) error {
	info, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		if root, err := os.OpenRoot(dir); err == nil {
			_ = fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
				if err == nil && d.Type().IsRegular() && keyFile(d.Name()) {
					shred(root, name)
				}
				return nil
			})
			root.Close()
		}
	}
	return os.RemoveAll(dir)
}

// keyFile names the panel's secret keys (master.key, agent-tls.key and
// their rotation leftovers).
func keyFile(name string) bool {
	return strings.HasSuffix(name, ".key") || strings.HasSuffix(name, ".key.new")
}

// shred overwrites a file with random bytes of its size. Best effort.
func shred(root *os.Root, name string) {
	f, err := root.OpenFile(name, os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	if _, err := io.CopyN(f, rand.Reader, info.Size()); err == nil {
		_ = f.Sync()
	}
}

// checkTLSPin dials addr and checks the server key against pin.
func checkTLSPin(ctx context.Context, addr string, pin []byte) error {
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: conn.PinnedTLSConfig(pin)}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	return c.Close()
}

// panelHealth reads the version from the panel's /api/health
// ({"status":"ok","version":...}); any other answer is an error.
func panelHealth(ctx context.Context, healthURL string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		return "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&body); err != nil {
		return "", fmt.Errorf("HTTP %d: %w", res.StatusCode, err)
	}
	if res.StatusCode != http.StatusOK || body.Status != "ok" {
		return "", fmt.Errorf("HTTP %d, status %q", res.StatusCode, body.Status)
	}
	return body.Version, nil
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
