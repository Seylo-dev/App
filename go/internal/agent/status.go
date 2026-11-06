package agent

import (
	"context"
	"io"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/stub"
	"github.com/seylo-dev/app/go/internal/version"
)

// recentErrors is how many errors the local status keeps.
const recentErrors = 10

// statusTracker remembers the connection state for `seylo status`.
type statusTracker struct {
	mu      sync.Mutex
	conn    localapi.ConnectionStatus
	session *rpc.Session
	errors  []localapi.ErrorEntry
}

func (s *statusTracker) connecting() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.State = "connecting"
	s.conn.Attempts++
	s.conn.NextAttempt = time.Time{}
}

func (s *statusTracker) connected(info ConnInfo, session *rpc.Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn = localapi.ConnectionStatus{
		State: "connected", PanelID: info.PanelID, PanelVersion: info.PanelVersion, SessionID: info.SessionID,
		Since: time.Now(), LastError: s.conn.LastError, LastErrorAt: s.conn.LastErrorAt,
	}
	s.session = session
}

func (s *statusTracker) disconnected(session *rpc.Session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == session {
		s.session = nil
	}
}

func (s *statusTracker) failed(state string, err error, retryIn time.Duration) {
	s.mu.Lock()
	s.conn.State = state
	s.conn.Since = time.Now()
	s.conn.SessionID = ""
	s.conn.NextAttempt = time.Now().Add(retryIn)
	s.mu.Unlock()
	s.recordError("connection", err)
}

func (s *statusTracker) recordError(source string, err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if source == "connection" {
		s.conn.LastError, s.conn.LastErrorAt = err.Error(), now
	}
	s.errors = append(s.errors, localapi.ErrorEntry{At: now, Source: source, Message: err.Error()})
	if len(s.errors) > recentErrors {
		s.errors = s.errors[len(s.errors)-recentErrors:]
	}
}

func (s *statusTracker) snapshot() (localapi.ConnectionStatus, []localapi.ErrorEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.conn
	if s.session != nil {
		st := s.session.Stats()
		c.InFlightCalls = st.IncomingCalls + st.OutgoingCalls
		c.InFlightStreams = st.IncomingStreams + st.OutgoingStreams
		c.EventsDropped = st.EventsDropped
	}
	return c, append([]localapi.ErrorEntry(nil), s.errors...)
}

// PanelControl starts the panel service and reads its logs for `seylo
// panel start|logs`. The owner that manages the Panel project sets
// Deps.PanelControl in its wire function; while it is nil both answer
// NOT_IMPLEMENTED.
type PanelControl interface {
	Start(ctx context.Context) error
	Logs(ctx context.Context, opts localapi.LogsOptions, w io.Writer) error
}

// PanelServiceName is the name of the panel's own service in the Panel
// project (a protected service). `seylo panel status` looks for it.
const PanelServiceName = "panel"

// localBackend serves the local API from the agent's live state.
type localBackend struct {
	deps    *Deps
	conn    *connector
	desired *state.DesiredSync
	outbox  *state.FileOutbox
	started time.Time
}

var _ localapi.Backend = (*localBackend)(nil)

func (b *localBackend) Version() localapi.VersionInfo {
	return localapi.VersionInfo{Version: version.String()}
}

func (b *localBackend) Status(ctx context.Context) (localapi.NodeStatus, error) {
	cfg := b.conn.config()
	connStatus, errs := b.conn.status.snapshot()
	snap := b.deps.State.Snapshot()
	desired := b.desired.Current()
	out := localapi.NodeStatus{
		NodeID:          cfg.NodeID,
		NodeName:        b.deps.Facts.Get().GetHostname(),
		AgentVersion:    version.String(),
		PanelURL:        cfg.PanelURL,
		PanelConnected:  connStatus.State == "connected",
		StartedAt:       b.started,
		Connection:      connStatus,
		DesiredRevision: desired.GetRevision(),
		AppliedRevision: snap.GetAppliedRevision(),
		RecentErrors:    errs,
		Services:        []localapi.ServiceSummary{},
	}
	if cfg.NodeName != "" {
		out.NodeName = cfg.NodeName
	}
	if b.outbox != nil {
		st := b.outbox.Stats()
		out.Outbox = localapi.OutboxStatus{Pending: st.Pending, Bytes: st.Bytes, Dropped: st.Dropped}
	}
	phases := map[string]agentv1.ServicePhase{}
	for _, svc := range snap.GetServices() {
		phases[svc.GetServiceId()] = svc.GetPhase()
	}
	for _, spec := range desired.GetServices() {
		out.Services = append(out.Services, localapi.ServiceSummary{
			ID: spec.GetId(), Name: spec.GetName(), Project: spec.GetProjectId(), Phase: phaseName(phases[spec.GetId()]),
		})
	}
	return out, nil
}

// phaseName turns SERVICE_PHASE_CRASH_LOOPING into "crash looping".
func phaseName(p agentv1.ServicePhase) string {
	if p == agentv1.ServicePhase_SERVICE_PHASE_UNSPECIFIED {
		return "unknown"
	}
	return strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(p.String(), "SERVICE_PHASE_")), "_", " ")
}

func (b *localBackend) PanelStatus(ctx context.Context) (localapi.PanelStatus, error) {
	cfg := b.conn.config()
	for _, spec := range b.desired.Current().GetServices() {
		if !spec.GetProtected() || spec.GetName() != PanelServiceName {
			continue
		}
		var phase agentv1.ServicePhase
		for _, st := range b.deps.State.Snapshot().GetServices() {
			if st.GetServiceId() == spec.GetId() {
				phase = st.GetPhase()
			}
		}
		ref := spec.GetImage().GetReference()
		ver := ""
		if i := strings.LastIndex(ref, ":"); i > strings.LastIndex(ref, "/") {
			ver = ref[i+1:]
		}
		return localapi.PanelStatus{
			Running: phase == agentv1.ServicePhase_SERVICE_PHASE_RUNNING,
			Version: ver,
			URL:     cfg.PanelURL,
			Phase:   phaseName(phase),
		}, nil
	}
	return localapi.PanelStatus{Phase: "not on this node", URL: cfg.PanelURL}, nil
}

func (b *localBackend) StartPanel(ctx context.Context) error {
	if b.deps.PanelControl == nil {
		return stub.NotImplemented("agent.PanelControl.Start")
	}
	return b.deps.PanelControl.Start(ctx)
}

func (b *localBackend) PanelLogs(ctx context.Context, opts localapi.LogsOptions, w io.Writer) error {
	if b.deps.PanelControl == nil {
		return stub.NotImplemented("agent.PanelControl.Logs")
	}
	return b.deps.PanelControl.Logs(ctx, opts, w)
}
