package docker

import (
	"strconv"

	"github.com/seylo-dev/app/go/gen/brand"
)

// LabelPrefix starts every label Seylo sets.
const LabelPrefix = brand.Slug + "."

// Label keys. They are part of the on-node contract: renaming one orphans
// every resource created by older agents.
const (
	// LabelManaged marks a resource as ours. Cleanup requires it.
	LabelManaged = LabelPrefix + "managed"
	LabelService = LabelPrefix + "service"
	LabelProject = LabelPrefix + "project"
	LabelKind    = LabelPrefix + "kind"
	// LabelGeneration is the ServiceSpec generation a container runs.
	LabelGeneration = LabelPrefix + "generation"
	LabelReplica    = LabelPrefix + "replica"
	// LabelProtected marks Panel project resources.
	LabelProtected = LabelPrefix + "protected"
	// LabelRole marks infrastructure we run ourselves: "traefik",
	// "registry", "db-ui", "cloudflared".
	LabelRole = LabelPrefix + "role"
	// LabelSpecHash is the hash of the container-relevant part of the
	// ServiceSpec (reconcile.SpecHash). A container whose hash matches the
	// desired spec does not need a new generation.
	LabelSpecHash = LabelPrefix + "spec-hash"
	// LabelVolume names the service volume a Docker volume backs.
	LabelVolume = LabelPrefix + "volume"
	// LabelUser is the uid:gid a panel container runs as (PanelUser). A
	// panel container without it runs as the image's user (uid 1000 before
	// 0.2.0-rc.2) and is replaced once by one that runs as PanelUser.
	LabelUser = LabelPrefix + "user"

	// LabelDNSCheck marks the Container DNS node check's test container
	// (nodecheck): a run cut off between docker create and start leaves it
	// behind, and the next run removes it by this label.
	LabelDNSCheck = LabelPrefix + "dnscheck"

	// LabelDNSCache is the node DNS cache's address on a container created
	// with it as its first DNS server (ContainerDNS, since 0.2.17). The
	// agent keeps the cache's address up while a container has it,
	// running or stopped.
	LabelDNSCache = LabelPrefix + "dns-cache"

	// LabelTraefikEnable is set to "false" on every container we create so
	// a Traefik with the Docker provider (Wings) ignores it.
	LabelTraefikEnable = "traefik.enable"
)

// InstanceLabels are the labels of one service container.
type InstanceLabels struct {
	ServiceID  string
	ProjectID  string
	Kind       string
	Generation uint64
	Replica    uint32
	Protected  bool
	// SpecHash is reconcile.SpecHash of the spec the container runs.
	SpecHash string
	// User is the --user the container runs with, recorded for the panel
	// (LabelUser); empty for every other service.
	User string
}

// Map returns the Docker label map for the instance, including the
// managed and Traefik opt-out labels.
func (l InstanceLabels) Map() map[string]string {
	m := map[string]string{
		LabelManaged:       "true",
		LabelTraefikEnable: "false",
		LabelService:       l.ServiceID,
		LabelProject:       l.ProjectID,
		LabelKind:          l.Kind,
		LabelGeneration:    strconv.FormatUint(l.Generation, 10),
		LabelReplica:       strconv.FormatUint(uint64(l.Replica), 10),
	}
	if l.Protected {
		m[LabelProtected] = "true"
	}
	if l.SpecHash != "" {
		m[LabelSpecHash] = l.SpecHash
	}
	if l.User != "" {
		m[LabelUser] = l.User
	}
	return m
}

// RoleLabels are the labels of infrastructure we run ourselves (Traefik,
// registry, database web UIs, cloudflared, cron runs, builds). serviceID
// may be empty. Reconcile never touches containers with a role: they
// belong to the component that created them.
func RoleLabels(role, serviceID string) map[string]string {
	m := map[string]string{
		LabelManaged:       "true",
		LabelTraefikEnable: "false",
		LabelRole:          role,
	}
	if serviceID != "" {
		m[LabelService] = serviceID
	}
	return m
}

// IsServiceInstance reports whether a container is a service instance
// owned by reconcile: managed, with a service id and no role.
func IsServiceInstance(labels map[string]string) bool {
	return IsManaged(labels) && labels[LabelService] != "" && labels[LabelRole] == ""
}

// IsManaged reports whether a resource's labels mark it as ours.
func IsManaged(labels map[string]string) bool {
	return labels[LabelManaged] == "true"
}
