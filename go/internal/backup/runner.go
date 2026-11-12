package backup

import (
	"context"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Runner performs backups and restores.
type Runner interface {
	// Start begins a backup in the background and returns once accepted.
	// The result is passed to report (which queues it in the outbox).
	Start(ctx context.Context, req *agentv1.RunBackupRequest, report func(*agentv1.BackupResult)) error
	// Restore restores an object and returns when done.
	Restore(ctx context.Context, req *agentv1.RestoreBackupRequest) (*agentv1.RestoreBackupResponse, error)
	// Inspect lists a database service's databases and tables, for
	// choosing what a backup holds.
	Inspect(ctx context.Context, req *agentv1.InspectDatabaseRequest) (*agentv1.InspectDatabaseResponse, error)
}
