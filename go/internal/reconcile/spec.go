package reconcile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/distribution/reference"
	"google.golang.org/protobuf/proto"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/state"
)

// SpecHash hashes the part of a ServiceSpec that is baked into a
// container at create time: image, command, env, volumes, files, network
// identity, resources and labels. Two specs with the same hash run in the
// same container, so a change that only touches routes, health checks,
// crash policy, replicas, cron jobs or dev access never restarts anything.
// Registry credentials are left out: rotating them does not change the
// image.
func SpecHash(s *agentv1.ServiceSpec) string {
	img := proto.Clone(s.GetImage()).(*agentv1.ImageRef)
	if img != nil {
		img.Auth = nil
	}
	h := &agentv1.ServiceSpec{
		Id:             s.GetId(),
		ProjectId:      s.GetProjectId(),
		Name:           s.GetName(),
		Kind:           s.GetKind(),
		Protected:      s.GetProtected(),
		Image:          img,
		Container:      s.GetContainer(),
		Env:            s.GetEnv(),
		Volumes:        s.GetVolumes(),
		Files:          s.GetFiles(),
		Resources:      s.GetResources(),
		NetworkAliases: s.GetNetworkAliases(),
	}
	if docker.IsPanelService(s.GetId(), s.GetProtected()) {
		// The panel's public ports are published by Docker at create time.
		h.Ports = s.GetPorts()
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(h)
	if err != nil {
		// Marshalling a valid message cannot fail; a panic here is a bug.
		panic(fmt.Sprintf("reconcile: hashing spec: %v", err))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// KindName is the seylo.kind label value of a service kind.
func KindName(k agentv1.ServiceKind) string {
	switch k {
	case agentv1.ServiceKind_SERVICE_KIND_COMPOSE_MEMBER:
		return "compose"
	case agentv1.ServiceKind_SERVICE_KIND_DATABASE:
		return "database"
	case agentv1.ServiceKind_SERVICE_KIND_BOX:
		return "box"
	case agentv1.ServiceKind_SERVICE_KIND_CRON:
		return "cron"
	}
	return "app"
}

// replicas is the number of instances a running service wants here.
func replicas(s *agentv1.ServiceSpec) int {
	if s.GetReplicas() == 0 {
		return 1
	}
	return int(s.GetReplicas())
}

// ImageRef returns the reference to run: repo@digest when the spec pins a
// digest (exact rollbacks), else the reference as given.
func ImageRef(img *agentv1.ImageRef) (string, error) {
	ref := img.GetReference()
	dg := img.GetDigest()
	if dg == "" {
		if ref == "" {
			return "", fmt.Errorf("the service has no image")
		}
		return ref, nil
	}
	if ref == "" {
		return "", fmt.Errorf("image digest %s without a repository", dg)
	}
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return "", fmt.Errorf("parsing image reference %q: %w", ref, err)
	}
	return reference.TrimNamed(named).String() + "@" + dg, nil
}

// fileName is the on-disk name of a file mount: a short hash of the
// container path (unique) plus its base name (readable).
func fileName(containerPath string) string {
	sum := sha256.Sum256([]byte(containerPath))
	base := strings.Map(func(r rune) rune {
		if r == '/' || r == 0 {
			return '_'
		}
		return r
	}, path.Base(containerPath))
	return hex.EncodeToString(sum[:6]) + "-" + base
}

// volumeOwner is the service whose folder holds a volume.
func volumeOwner(s *agentv1.ServiceSpec, v *agentv1.VolumeMount) string {
	if v.GetOwnerServiceId() != "" {
		return v.GetOwnerServiceId()
	}
	return s.GetId()
}

// instanceHash is the spec hash an instance runs. The installer's first
// panel container carries no hash label: a protected instance without one
// at the desired generation counts as running the desired spec, so the
// agent adopts it as is instead of rolling the panel. Any later spec change comes with a new generation and rolls it.
//
// A panel container that does not run as docker.PanelUser (no LabelUser:
// started by an agent or installer from before 0.2.0-rc.2, as the image's
// uid 1000) serves no spec, so it is replaced once by one that does, after
// preparePanelDir moved the folder to that user.
func instanceHash(labels map[string]string, spec *agentv1.ServiceSpec, hash string) string {
	if docker.IsPanelService(spec.GetId(), spec.GetProtected()) && labels[docker.LabelUser] != docker.PanelUser {
		return ""
	}
	if h := labels[docker.LabelSpecHash]; h != "" {
		return h
	}
	if spec.GetProtected() && labels[docker.LabelProtected] == "true" &&
		labels[docker.LabelGeneration] == strconv.FormatUint(spec.GetGeneration(), 10) {
		return hash
	}
	return ""
}

// panelBind mounts the panel's data folder at the same path the installer
// used: the panel service has no volumes in its spec, and the panel swap
// snapshots that folder.
func panelBind(layout datadir.Layout) string {
	return filepath.Join(layout.Root(), "panel") + ":" + brand.DataDir + "/panel"
}

// panelPublish is the panel's FORWARD public ports, published by Docker
// like the installer does, so the panel answers while the agent restarts.
func panelPublish(s *agentv1.ServiceSpec) []docker.PortPublish {
	var out []docker.PortPublish
	for _, p := range s.GetPorts() {
		pub := p.GetPublic()
		if pub.GetHostPort() == 0 || p.GetProtocol() == agentv1.PortProtocol_PORT_PROTOCOL_UDP ||
			pub.GetMode() == agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT {
			continue
		}
		out = append(out, docker.PortPublish{HostPort: pub.GetHostPort(), ContainerPort: p.GetContainerPort()})
	}
	return out
}

// prepareData creates the service's volumes (folders and Docker volumes)
// and writes its file mounts. It returns the binds and mounts for the
// container.
func prepareData(ctx context.Context, eng docker.Engine, layout datadir.Layout, s *agentv1.ServiceSpec, scope map[string]string) (binds []string, mounts []docker.VolumeMount, err error) {
	for _, v := range s.GetVolumes() {
		owner := volumeOwner(s, v)
		dir, err := layout.ServiceVolume(owner, v.GetName())
		if err != nil {
			return nil, nil, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, fmt.Errorf("creating volume folder: %w", err)
		}
		name := docker.VolumeName(owner, v.GetName())
		labels := map[string]string{docker.LabelService: owner, docker.LabelVolume: v.GetName()}
		for k, val := range scope {
			labels[k] = val
		}
		if err := eng.EnsureVolume(ctx, name, dir, labels); err != nil {
			return nil, nil, err
		}
		target := v.GetContainerPath()
		if !path.IsAbs(target) {
			return nil, nil, fmt.Errorf("volume %s: container path %q is not absolute", v.GetName(), target)
		}
		mounts = append(mounts, docker.VolumeMount{Volume: name, Target: target, ReadOnly: v.GetReadOnly()})
	}
	if len(s.GetFiles()) > 0 {
		dir, err := layout.ServiceFiles(s.GetId())
		if err != nil {
			return nil, nil, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, fmt.Errorf("creating files folder: %w", err)
		}
		for _, f := range s.GetFiles() {
			target := f.GetContainerPath()
			if !path.IsAbs(target) || path.Clean(target) == "/" {
				return nil, nil, fmt.Errorf("file mount path %q is not an absolute file path", target)
			}
			host := filepath.Join(dir, fileName(target))
			mode := os.FileMode(f.GetMode() & 0o7777)
			if mode == 0 {
				mode = 0o644
			}
			if err := writeFileAtomic(host, f.GetContent(), mode); err != nil {
				return nil, nil, fmt.Errorf("writing file mount %s: %w", target, err)
			}
			binds = append(binds, host+":"+target+":ro")
		}
	}
	if docker.IsPanelService(s.GetId(), s.GetProtected()) {
		// Its owner and modes are set by preparePanelDir, right before a
		// panel container is created (the old one may still run now).
		dir := filepath.Join(layout.Root(), "panel")
		if err := os.MkdirAll(dir, panelDirMode); err != nil {
			return nil, nil, fmt.Errorf("creating the panel folder: %w", err)
		}
		binds = append(binds, panelBind(layout))
	}
	return binds, mounts, nil
}

// writeFileAtomic replaces name with data through state.WriteFileAtomic
// (temp file, fsync, rename, fsync of the folder), so a power loss never
// leaves runtime.json or a file mount empty or half written. A file that
// already holds data with this mode is left alone (no new inode, no
// fsync on every pass).
func writeFileAtomic(name string, data []byte, mode os.FileMode) error {
	if fi, err := os.Lstat(name); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm() == mode.Perm() && fi.Size() == int64(len(data)) {
		if cur, err := os.ReadFile(name); err == nil && bytes.Equal(cur, data) {
			return nil
		}
	}
	return state.WriteFileAtomic(name, data, mode)
}

// containerSpec builds the container of one instance.
func containerSpec(s *agentv1.ServiceSpec, image string, gen uint64, replica uint32, hash string, binds []string, mounts []docker.VolumeMount) docker.ContainerSpec {
	c := s.GetContainer()
	env := make([]string, 0, len(s.GetEnv()))
	for _, e := range s.GetEnv() {
		env = append(env, e.GetName()+"="+e.GetValue())
	}
	aliases := append([]string{s.GetName()}, s.GetNetworkAliases()...)
	r := s.GetResources()
	var publish []docker.PortPublish
	user, labelUser := c.GetUser(), ""
	if docker.IsPanelService(s.GetId(), s.GetProtected()) {
		publish = panelPublish(s)
		// The agent decides the panel's user, not the spec: a panel that
		// set it would make an agent from before the panel user start it
		// as that user on a folder still owned by uid 1000.
		user, labelUser = docker.PanelUser, docker.PanelUser
	}
	return docker.ContainerSpec{
		Publish:    publish,
		Name:       docker.ContainerName(s.GetId(), gen, replica),
		Image:      image,
		Command:    c.GetCommand(),
		Entrypoint: c.GetEntrypoint(),
		WorkingDir: c.GetWorkingDir(),
		User:       user,
		Env:        env,
		Labels: docker.InstanceLabels{
			ServiceID:  s.GetId(),
			ProjectID:  s.GetProjectId(),
			Kind:       KindName(s.GetKind()),
			Generation: gen,
			Replica:    replica,
			Protected:  s.GetProtected(),
			SpecHash:   hash,
			User:       labelUser,
		}.Map(),
		Binds:             binds,
		Mounts:            mounts,
		Network:           docker.ProjectNetwork(s.GetProjectId()),
		Aliases:           aliases,
		Hostname:          hostname(s.GetName()),
		StopSignal:        c.GetStopSignal(),
		StopGrace:         c.GetStopGracePeriod().AsDuration(),
		OpenStdin:         true,
		MemoryLimit:       r.GetMemoryLimitBytes(),
		MemoryReservation: r.GetMemoryReservationBytes(),
		CPUWeight:         r.GetCpuWeight(),
		PidsLimit:         r.GetPidsLimit(),
	}
}

// hostname keeps a DNS-label-safe name (at most 63 characters).
func hostname(name string) string {
	if len(name) > 63 {
		name = name[:63]
	}
	return strings.Trim(name, "-.")
}
