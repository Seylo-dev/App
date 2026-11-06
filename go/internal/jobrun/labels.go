package jobrun

import (
	"maps"

	"github.com/seylo-dev/app/go/internal/docker"
)

// Roles the jobs packages put in docker.LabelRole. Cleanup and the helpers find their
// containers by them.
const (
	RoleCron        = "cron"
	RoleBackup      = "backup"
	RoleDBUI        = "db-ui"
	RoleBox         = "box"
	RoleCloudflared = "cloudflared"
)

// Extra label keys of jobs containers.
const (
	// LabelCronJob is the CronJob.id of a cron run container (empty for
	// SERVICE_KIND_CRON services).
	LabelCronJob = docker.LabelPrefix + "cron-job"
	// LabelRun is the run id of a one-off container.
	LabelRun = docker.LabelPrefix + "run"
	// LabelSpecHash lets helpers recreate a container when what it should
	// run changed.
	LabelSpecHash = docker.LabelPrefix + "spec-hash"
)

// Owner identifies the service a container belongs to.
type Owner struct {
	ServiceID string
	ProjectID string
	// Kind is the service kind label value ("cron", "database", "box", ...).
	Kind string
	// Generation of the service the container was made for; 0 when it does
	// not matter.
	Generation uint64
	Protected  bool
}

// Labels returns the full label set of a jobs container: the managed and
// Traefik opt-out labels, the owner's identifying labels, the role and
// any extra labels.
func Labels(o Owner, role string, extra map[string]string) map[string]string {
	m := docker.InstanceLabels{
		ServiceID:  o.ServiceID,
		ProjectID:  o.ProjectID,
		Kind:       o.Kind,
		Generation: o.Generation,
		Protected:  o.Protected,
	}.Map()
	m[docker.LabelRole] = role
	maps.Copy(m, extra)
	// Never let extra labels drop the guarantees.
	m[docker.LabelManaged] = "true"
	m[docker.LabelTraefikEnable] = "false"
	return m
}
