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
}

// LogsOptions controls PanelLogs.
type LogsOptions struct {
	Tail   int  `json:"tail"`
	Follow bool `json:"follow"`
}

// VersionInfo is the running agent's version.
type VersionInfo struct {
	Version string `json:"version"`
}
