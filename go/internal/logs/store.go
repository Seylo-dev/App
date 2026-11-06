package logs

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Store keeps log lines per service and per build.
type Store interface {
	// Append adds lines to a service's log. Entries must not be changed
	// after the call: live followers share them.
	Append(serviceID string, entries ...*agentv1.LogEntry) error
	// BuildLog opens the log of one build for writing raw builder output
	// (partial lines are joined). Followers of the build see it live, and
	// their stream ends once the writer is closed.
	BuildLog(buildID string) (io.WriteCloser, error)
	// Follow sends history then live lines to fn in batches until ctx ends
	// or fn returns an error. For a build it returns nil once the build log
	// is closed and everything was sent.
	Follow(ctx context.Context, req *agentv1.LogsFollowRequest, fn func([]*agentv1.LogEntry) error) error
	// Search scans history newest first.
	Search(ctx context.Context, req *agentv1.LogsSearchRequest) (*agentv1.LogsSearchResponse, error)
	// Tail returns the last n lines of a service, for crash reports.
	Tail(serviceID string, n int) ([]string, error)
	// Delete removes a service's logs (service removed with delete_data).
	Delete(serviceID string) error
}

var _ Store = (*FileStore)(nil)
