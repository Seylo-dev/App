package jobrun

import (
	"fmt"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
)

// Helpers that turn a ServiceSpec into the pieces of a job container: the
// same image, env, volumes and network as the service.

// ImageRef is the reference to run: pinned to the digest when the panel
// sent one (that is what makes rollbacks exact), else the reference.
func ImageRef(ref *agentv1.ImageRef) string {
	r, digest := ref.GetReference(), ref.GetDigest()
	if digest == "" || strings.Contains(r, "@") {
		return r
	}
	if r == "" {
		return digest
	}
	// Drop a tag: it is after the last ':' only when no '/' follows it
	// (a ':' before the last '/' is a registry port).
	name := r
	if i := strings.LastIndexByte(r, ':'); i > strings.LastIndexByte(r, '/') {
		name = r[:i]
	}
	return name + "@" + digest
}

// KindLabel is the seylo.kind label value of a service kind: "app",
// "database", "cron", ...
func KindLabel(k agentv1.ServiceKind) string {
	return strings.ToLower(strings.TrimPrefix(k.String(), "SERVICE_KIND_"))
}

// OwnerOf is the label owner of containers made for spec.
func OwnerOf(spec *agentv1.ServiceSpec) Owner {
	return Owner{
		ServiceID:  spec.GetId(),
		ProjectID:  spec.GetProjectId(),
		Kind:       KindLabel(spec.GetKind()),
		Generation: spec.GetGeneration(),
		Protected:  spec.GetProtected(),
	}
}

// Env is the service env as KEY=value pairs.
func Env(spec *agentv1.ServiceSpec) []string {
	out := make([]string, 0, len(spec.GetEnv()))
	for _, e := range spec.GetEnv() {
		out = append(out, e.GetName()+"="+e.GetValue())
	}
	return out
}

// Secrets are the values of env vars marked secret, for redaction.
func Secrets(spec *agentv1.ServiceSpec) []string {
	var out []string
	for _, e := range spec.GetEnv() {
		if e.GetSecret() {
			out = append(out, e.GetValue())
		}
	}
	return out
}

// VolumeBinds binds the service's volumes from their folders under the
// data dir, exactly where the service sees them.
func VolumeBinds(layout datadir.Layout, spec *agentv1.ServiceSpec) ([]string, error) {
	out := make([]string, 0, len(spec.GetVolumes()))
	for _, v := range spec.GetVolumes() {
		owner := v.GetOwnerServiceId()
		if owner == "" {
			owner = spec.GetId()
		}
		host, err := layout.ServiceVolume(owner, v.GetName())
		if err != nil {
			return nil, err
		}
		b := host + ":" + v.GetContainerPath()
		if v.GetReadOnly() {
			b += ":ro"
		}
		out = append(out, b)
	}
	return out, nil
}

// ProjectNetwork is the network a service's job containers join.
func ProjectNetwork(spec *agentv1.ServiceSpec) string {
	return docker.ProjectNetwork(spec.GetProjectId())
}

// HelperName is the name of a helper container of a service, for example
// seylo-<svc>-db-ui.
func HelperName(serviceID, what string) string {
	return fmt.Sprintf("%s-%s-%s", brand.Slug, serviceID, what)
}

// ApplyResources copies the service's optional limits to a job spec.
func ApplyResources(s *Spec, r *agentv1.Resources) {
	s.MemoryLimit = r.GetMemoryLimitBytes()
	s.MemoryReservation = r.GetMemoryReservationBytes()
	s.CPUWeight = r.GetCpuWeight()
	s.PidsLimit = r.GetPidsLimit()
}
