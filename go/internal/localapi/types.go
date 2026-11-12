package localapi

import "time"

// NodeStatus is what `seylo status` prints.
type NodeStatus struct {
	NodeID         string           `json:"nodeId"`
	NodeName       string           `json:"nodeName"`
	AgentVersion   string           `json:"agentVersion"`
	PanelURL       string           `json:"panelUrl"`
	PanelConnected bool             `json:"panelConnected"`
	Services       []ServiceSummary `json:"services"`
	// StartedAt is when the agent process started.
	StartedAt  time.Time        `json:"startedAt"`
	Connection ConnectionStatus `json:"connection"`
	Outbox     OutboxStatus     `json:"outbox"`
	// DesiredRevision is the stored desired state; AppliedRevision what
	// reconcile reported as fully applied.
	DesiredRevision uint64 `json:"desiredRevision"`
	AppliedRevision uint64 `json:"appliedRevision"`
	// RecentErrors are the last connection and outbox errors, newest last.
	RecentErrors []ErrorEntry `json:"recentErrors"`
	// RouteErrors are the services whose route file the agent cannot write
	// now (ServiceStatus.route_write_error), oldest first: At is the first
	// failure, Source "routes of <service>". Their domains have no route on
	// this node until it is written (added in 0.2.12).
	RouteErrors []ErrorEntry `json:"routeErrors,omitempty"`
	// Busy names the node operation in progress ("agent update", "panel
	// update", "Docker update", "reboot"), or "" (added in 0.2.1: an older
	// agent leaves it empty).
	Busy string `json:"busy,omitempty"`
}

// ConnectionStatus describes the panel connection.
type ConnectionStatus struct {
	// State is "connecting", "connected", "waiting" (backing off before
	// the next attempt) or "rejected" (the panel refused the agent).
	State        string    `json:"state"`
	PanelID      string    `json:"panelId,omitempty"`
	PanelVersion string    `json:"panelVersion,omitempty"`
	SessionID    string    `json:"sessionId,omitempty"`
	Since        time.Time `json:"since"`
	// Attempts counts connection attempts since the last success.
	Attempts    int       `json:"attempts"`
	LastError   string    `json:"lastError,omitempty"`
	LastErrorAt time.Time `json:"lastErrorAt"`
	NextAttempt time.Time `json:"nextAttempt"`
	// Counters of the current session.
	InFlightCalls   int64 `json:"inFlightCalls"`
	InFlightStreams int64 `json:"inFlightStreams"`
	EventsDropped   int64 `json:"eventsDropped"`
}

// OutboxStatus describes the queue of durable reports.
type OutboxStatus struct {
	Pending int    `json:"pending"`
	Bytes   int64  `json:"bytes"`
	Dropped uint64 `json:"dropped"`
}

// ErrorEntry is one remembered error.
type ErrorEntry struct {
	At      time.Time `json:"at"`
	Source  string    `json:"source"`
	Message string    `json:"message"`
}

// ServiceSummary is one line of the status service list.
type ServiceSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Project string `json:"project"`
	Phase   string `json:"phase"`
}

// PanelStatus is what `seylo panel status` prints.
type PanelStatus struct {
	Running bool   `json:"running"`
	Version string `json:"version"`
	URL     string `json:"url"`
	Phase   string `json:"phase"`
	// IPAccess is the panel's own port and AgentPort the agents' TLS
	// port, as Docker publishes them for the running panel container
	// (added in 0.2.1: an older agent leaves both empty).
	IPAccess  PortAccess `json:"ipAccess"`
	AgentPort PortAccess `json:"agentPort"`
	// Tailnet is the panel's Tailscale Serve entry on this server (added
	// in 0.2.1): nil when the agent sees no tailscaled, or is older.
	Tailnet *TailnetAccess `json:"tailnet,omitempty"`
}

// TailnetAccess is where the panel's Tailscale Serve entry stands, as the
// agent last read it from the host's tailscaled.
type TailnetAccess struct {
	// State is "off", "applying", "active", "conflict", "error" or
	// "unsupported" (TailnetServeState), or TailnetDisabled.
	State string `json:"state"`
	// URL is where the panel answers on the tailnet, set while active.
	URL string `json:"url,omitempty"`
	// Message says why for conflict, error and unsupported, and what
	// tailscaled is doing when it is not running.
	Message string `json:"message,omitempty"`
}

// TailnetDisabled: config.yml sets no_tailnet: true (`seylo panel
// tailscale off`), so the agent keeps no Serve entry.
const TailnetDisabled = "disabled"

// PortAccess is how one of the panel's ports is published on the host.
type PortAccess struct {
	// State is PortOpen, PortClosed, PortOff or PortUnknown.
	State string `json:"state,omitempty"`
	// Bindings are the host sides, for example "127.0.0.1:3000", or
	// "0.0.0.0:3443" for every address.
	Bindings []string `json:"bindings,omitempty"`
}

// PortAccess states.
const (
	// PortOpen: published on an address other machines can reach (every
	// address, as before 0.2.1).
	PortOpen = "open"
	// PortClosed: published on 127.0.0.1 (or ::1) only, so only the
	// server itself and an SSH tunnel reach it.
	PortClosed = "closed"
	// PortOff: not published at all (no agents' TLS port).
	PortOff = "off"
	// PortUnknown: no running panel container to read it from.
	PortUnknown = "unknown"
)

// LogsOptions controls PanelLogs.
type LogsOptions struct {
	Tail   int  `json:"tail"`
	Follow bool `json:"follow"`
}

// VersionInfo is the running agent's version.
type VersionInfo struct {
	Version string `json:"version"`
}
