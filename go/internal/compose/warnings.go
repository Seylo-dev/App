package compose

import (
	"fmt"
	"slices"
	"strings"

	"github.com/compose-spec/compose-go/v2/types"
)

// Warnings lists what the agent will not run as written, one line each,
// grouped by service in name order, then the project-level ones. unset
// are variables the file used without a value.
func Warnings(p *types.Project, unset []string) []string {
	var w []string
	add := func(format string, args ...any) { w = append(w, fmt.Sprintf(format, args...)) }

	names := slices.Sorted(func(yield func(string) bool) {
		for n := range p.Services {
			if !yield(n) {
				return
			}
		}
	})
	for _, name := range names {
		s := p.Services[name]
		svc := func(format string, args ...any) { add("%s: "+format, append([]any{name}, args...)...) }
		serviceWarnings(s, svc)
	}

	for _, name := range slices.Sorted(mapKeys(p.DisabledServices)) {
		add("%s: skipped, its profile is not active", name)
	}
	for _, name := range slices.Sorted(mapKeys(p.Networks)) {
		n := p.Networks[name]
		switch {
		case bool(n.External):
			add("network %s: external networks are not supported; services share the stack's private network", name)
		case name != "default":
			add("network %s: custom networks are replaced by the stack's private network", name)
		}
	}
	for _, name := range slices.Sorted(mapKeys(p.Volumes)) {
		v := p.Volumes[name]
		switch {
		case bool(v.External):
			add("volume %s: external volumes are not supported; a new empty volume is created", name)
		case v.Driver != "" && v.Driver != "local", len(v.DriverOpts) > 0:
			add("volume %s: volume drivers and driver options are ignored; it is a local volume", name)
		}
	}
	for _, name := range slices.Sorted(mapKeys(p.Secrets)) {
		fileObject(types.FileObjectConfig(p.Secrets[name]), "secret", name, add)
	}
	for _, name := range slices.Sorted(mapKeys(p.Configs)) {
		fileObject(types.FileObjectConfig(p.Configs[name]), "config", name, add)
	}
	if len(p.Models) > 0 {
		add("models are not supported and are ignored")
	}
	if len(p.Jobs) > 0 {
		add("jobs are not supported; use a cron job on a service instead")
	}
	slices.Sort(unset)
	for _, v := range unset {
		add("variable %s is not set; it was replaced with an empty value", v)
	}
	return w
}

func fileObject(o types.FileObjectConfig, kind, name string, add func(string, ...any)) {
	switch {
	case bool(o.External):
		add("%s %s: external %ss are not supported", kind, name, kind)
	case o.File != "":
		add("%s %s: reading %s from a file is not supported; use content or environment", kind, name, o.File)
	}
}

func serviceWarnings(s types.ServiceConfig, w func(string, ...any)) {
	switch {
	case s.NetworkMode == "host":
		w("network_mode host is not supported; the service joins the stack's private network")
	case strings.HasPrefix(s.NetworkMode, types.NetworkModeServicePrefix), strings.HasPrefix(s.NetworkMode, types.NetworkModeContainerPrefix):
		w("network_mode %s is not supported; the service gets its own network namespace", s.NetworkMode)
	case s.NetworkMode == "none":
		w("network_mode none is ignored; the service joins the stack's private network")
	}
	if s.Privileged {
		w("privileged mode is not supported and is ignored")
	}
	if len(s.CapAdd) > 0 {
		w("cap_add (%s) is ignored", strings.Join(s.CapAdd, ", "))
	}
	if len(s.Devices) > 0 || len(s.Gpus) > 0 {
		w("devices and GPUs are not supported")
	}
	for _, ns := range []struct{ key, value string }{{"pid", s.Pid}, {"ipc", s.Ipc}, {"uts", s.Uts}, {"userns_mode", s.UserNSMode}, {"cgroup", s.Cgroup}} {
		if ns.value == "host" {
			w("%s: host is not supported and is ignored", ns.key)
		}
	}
	if s.CgroupParent != "" || s.Runtime != "" || s.Isolation != "" {
		w("cgroup_parent, runtime and isolation are ignored")
	}
	if len(s.Sysctls) > 0 {
		w("sysctls are ignored")
	}
	if s.Build != nil {
		w("build sections are not built for compose stacks; give the service an image")
	} else if s.Image == "" {
		w("has no image")
	}
	if s.Build != nil && s.PullPolicy == types.PullPolicyBuild {
		w("pull_policy build needs a build; set an image")
	}
	for _, p := range s.Ports {
		target := fmt.Sprint(p.Target)
		switch {
		case p.Protocol == "udp":
			w("UDP port %s is not supported", target)
		case p.Published != "":
			w("port %s is published on the host as %s; instead add a domain for container port %s, or open it on IP:port from the service's networking", target, p.Published, target)
		default:
			w("port %s is published on a random host port; add a domain or open it on IP:port instead", target)
		}
	}
	for _, v := range s.Volumes {
		switch v.Type {
		case types.VolumeTypeBind:
			if v.Source == "/var/run/docker.sock" || v.Source == "/run/docker.sock" {
				w("mounting the Docker socket gives full control of the node and is not supported")
			} else {
				w("bind mount %s:%s is not supported; use a named volume (files outside the stack are not on the node)", v.Source, v.Target)
			}
		case types.VolumeTypeNamedPipe, types.VolumeTypeCluster, types.VolumeTypeImage:
			w("%s mount %s is not supported", v.Type, v.Target)
		}
	}
	if len(s.VolumesFrom) > 0 {
		w("volumes_from is not supported; mount the same named volume instead")
	}
	if len(s.EnvFiles) > 0 {
		w("env_file is not read; put those variables in the stack's environment")
	}
	if s.ContainerName != "" {
		w("container_name is ignored; containers get their own names")
	}
	if s.Restart != "" && s.Restart != types.RestartPolicyNo {
		w("restart %s is replaced by the service's crash policy", s.Restart)
	}
	if d := s.Deploy; d != nil {
		if d.Mode == "global" {
			w("deploy mode global is not supported; choose nodes and replicas in the service's settings")
		}
		if len(d.Placement.Constraints) > 0 || len(d.Placement.Preferences) > 0 {
			w("placement constraints are ignored; choose nodes in the service's settings")
		}
	}
	if s.Logging != nil && s.Logging.Driver != "" && s.Logging.Driver != "json-file" && s.Logging.Driver != "local" {
		w("logging driver %s is ignored; logs are kept on the node", s.Logging.Driver)
	}
	if len(s.PostStart) > 0 || len(s.PreStop) > 0 {
		w("post_start and pre_stop hooks are not supported")
	}
	if len(s.ExternalLinks) > 0 {
		w("external_links are not supported")
	}
	if s.Provider != nil {
		w("provider services are not supported")
	}
	if len(s.Models) > 0 {
		w("models are not supported")
	}
	for k := range s.Labels {
		if strings.HasPrefix(k, "traefik.") {
			w("Traefik labels are ignored; add domains to the service instead")
			break
		}
	}
}

func mapKeys[M ~map[string]V, V any](m M) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}
