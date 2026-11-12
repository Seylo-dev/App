package agent

import (
	"context"
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/docker"
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

// recordError keeps err for seylo status as one line of printable text: a
// dial error can quote what whoever answers at the panel's address chose
// (a certificate's names), and a line break in it would print a line of
// its own, a fake "Panel: ... (connected)" for the installer.
func (s *statusTracker) recordError(source string, err error) {
	if err == nil {
		return
	}
	msg := conn.PrintableLine(err.Error())
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if source == "connection" {
		s.conn.LastError, s.conn.LastErrorAt = msg, now
	}
	s.errors = append(s.errors, localapi.ErrorEntry{At: now, Source: source, Message: msg})
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
	if b.deps.Updater != nil {
		out.Busy = b.deps.Updater.Busy()
	}
	if b.outbox != nil {
		st := b.outbox.Stats()
		out.Outbox = localapi.OutboxStatus{Pending: st.Pending, Bytes: st.Bytes, Dropped: st.Dropped}
	}
	phases := map[string]agentv1.ServicePhase{}
	for _, svc := range snap.GetServices() {
		phases[svc.GetServiceId()] = svc.GetPhase()
	}
	names := map[string]string{}
	for _, spec := range desired.GetServices() {
		names[spec.GetId()] = spec.GetName()
		out.Services = append(out.Services, localapi.ServiceSummary{
			ID: spec.GetId(), Name: spec.GetName(), Project: spec.GetProjectId(), Phase: phaseName(phases[spec.GetId()]),
		})
	}
	out.RouteErrors = routeErrors(snap.GetServices(), names)
	return out, nil
}

// routeErrors lists the services whose route file reconcile cannot write,
// oldest failure first, named as the desired state names them (by id
// when it does not).
func routeErrors(statuses []*agentv1.ServiceStatus, names map[string]string) []localapi.ErrorEntry {
	var out []localapi.ErrorEntry
	for _, svc := range statuses {
		e := svc.GetRouteWriteError()
		if e.GetMessage() == "" {
			continue
		}
		name := names[svc.GetServiceId()]
		if name == "" {
			name = svc.GetServiceId()
		}
		out = append(out, localapi.ErrorEntry{At: e.GetSince().AsTime(), Source: "routes of " + name, Message: conn.PrintableLine(e.GetMessage())})
	}
	slices.SortStableFunc(out, func(a, b localapi.ErrorEntry) int { return a.At.Compare(b.At) })
	return out
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
		out := localapi.PanelStatus{
			Running: phase == agentv1.ServicePhase_SERVICE_PHASE_RUNNING,
			Version: ver,
			URL:     cfg.PanelURL,
			Phase:   phaseName(phase),
		}
		out.IPAccess, out.AgentPort = b.panelPorts(ctx, spec)
		out.Tailnet = panelTailnet(b.deps.Facts.Get().GetTailscale())
		return out, nil
	}
	return localapi.PanelStatus{Phase: "not on this node", URL: cfg.PanelURL}, nil
}

// panelPorts reports how Docker actually publishes the panel's own port
// and the agents' TLS port: the bindings of the running panel container,
// not what the desired state asks for, so a close that failed and rolled
// back shows as open.
func (b *localBackend) panelPorts(ctx context.Context, spec *agentv1.ServiceSpec) (panel, agents localapi.PortAccess) {
	panelPort, agentPort := panelContainerPorts(spec)
	agents = localapi.PortAccess{State: localapi.PortUnknown}
	if agentPort == 0 {
		agents = localapi.PortAccess{State: localapi.PortOff}
	}
	publish, ok := b.runningPanelPublish(ctx, spec.GetId())
	if !ok {
		return localapi.PortAccess{State: localapi.PortUnknown}, agents
	}
	panel = portAccess(publish, panelPort)
	if agentPort != 0 {
		agents = portAccess(publish, agentPort)
	}
	return panel, agents
}

// panelTailnet turns the tailnet area's last report (NodeFacts.tailscale)
// into the Tailnet line of `seylo panel status`; nil without tailscaled.
func panelTailnet(info *agentv1.TailscaleInfo) *localapi.TailnetAccess {
	if info == nil {
		return nil
	}
	if info.GetDisabledOnServer() {
		return &localapi.TailnetAccess{State: localapi.TailnetDisabled, Message: "no_tailnet is set in config.yml"}
	}
	serve := info.GetServe()
	out := &localapi.TailnetAccess{State: "off", URL: serve.GetUrl(), Message: serve.GetMessage()}
	if s := serve.GetState(); s != agentv1.TailnetServeState_TAILNET_SERVE_STATE_UNSPECIFIED {
		out.State = strings.ToLower(strings.TrimPrefix(s.String(), "TAILNET_SERVE_STATE_"))
	}
	if out.State != "active" {
		out.URL = ""
	}
	if out.Message == "" {
		out.Message = tailscaleNotRunning(info.GetBackendState())
	}
	return out
}

// tailscaleNotRunning says why tailscaled cannot serve, in words; empty
// while it runs.
func tailscaleNotRunning(state string) string {
	switch state {
	case "Running":
		return ""
	case "NeedsLogin":
		return "Tailscale needs a sign-in"
	case "NeedsMachineAuth":
		return "Tailscale waits for approval in the admin console"
	case "Stopped":
		return "Tailscale is stopped"
	case "":
		return "Tailscale is not running"
	}
	return "Tailscale is " + state
}

// panelContainerPorts reads the panel's ports inside its container from
// the env panelContributor sets: <SLUG>_PORT (3000 when unset) and
// <SLUG>_AGENT_TLS_PORT (0: the agents' TLS port is off).
func panelContainerPorts(spec *agentv1.ServiceSpec) (panel, agents uint32) {
	prefix := strings.ToUpper(brand.Slug) + "_"
	panel = 3000
	for _, e := range spec.GetEnv() {
		v, err := strconv.ParseUint(e.GetValue(), 10, 16)
		if err != nil || v == 0 {
			continue
		}
		switch e.GetName() {
		case prefix + "PORT":
			panel = uint32(v)
		case prefix + "AGENT_TLS_PORT":
			agents = uint32(v)
		}
	}
	return panel, agents
}

// runningPanelPublish returns the Docker bindings of a running panel
// container; false when none runs or Docker does not answer in time.
func (b *localBackend) runningPanelPublish(ctx context.Context, serviceID string) ([]docker.PortPublish, bool) {
	if b.deps.Docker == nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	list, err := b.deps.Docker.ListContainers(ctx, map[string]string{docker.LabelService: serviceID})
	if err != nil {
		return nil, false
	}
	for _, c := range list {
		if !docker.IsServiceInstance(c.Labels) || c.State != agentv1.InstanceState_INSTANCE_STATE_RUNNING {
			continue
		}
		if d, err := b.deps.Docker.InspectContainer(ctx, c.ID); err == nil && d.Running {
			return d.Publish, true
		}
	}
	return nil, false
}

// portAccess describes the bindings of one container port: open when any
// is on an address other than loopback (the zero address is every one).
func portAccess(publish []docker.PortPublish, containerPort uint32) localapi.PortAccess {
	out := localapi.PortAccess{State: localapi.PortOff}
	for _, p := range publish {
		if p.ContainerPort != containerPort {
			continue
		}
		out.Bindings = append(out.Bindings, p.Host())
		if !p.HostIP.IsLoopback() {
			out.State = localapi.PortOpen
		} else if out.State == localapi.PortOff {
			out.State = localapi.PortClosed
		}
	}
	return out
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
