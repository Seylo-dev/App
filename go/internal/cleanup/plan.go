package cleanup

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/jobrun"
)

// KeepImagesPerService is how many of a service's newest images survive
// a prune besides the ones in use, so rollback stays instant.
const KeepImagesPerService = 3

// ItemKind is what an item removes.
type ItemKind string

const (
	KindContainer ItemKind = "container"
	KindImage     ItemKind = "image"
	KindVolume    ItemKind = "volume"
	KindNetwork   ItemKind = "network"
	KindData      ItemKind = "data"
)

// Item is one thing a prune removes (or would remove).
type Item struct {
	Kind ItemKind
	// ID is what the removal call takes: container/image/network id,
	// volume name or folder path.
	ID   string
	Name string
	Size int64
	// Why it goes, for the report.
	Reason string
}

// Describe is the line shown in the panel.
func (it Item) Describe() string {
	s := fmt.Sprintf("%s %s", it.Kind, it.Name)
	if it.Size > 0 {
		s += " (" + humanBytes(it.Size) + ")"
	}
	if it.Reason != "" {
		s += ": " + it.Reason
	}
	return s
}

// Snapshot is everything a plan looks at.
type Snapshot struct {
	Desired    *agentv1.DesiredState
	Containers []jobrun.Container
	Images     []jobrun.Image
	Volumes    []jobrun.Volume
	Networks   []jobrun.Network
	// ServiceDirs are the folders under <data dir>/services.
	ServiceDirs []ServiceDir
}

// ServiceDir is one services/<id> folder.
type ServiceDir struct {
	ServiceID string
	Path      string
	Size      int64
}

// Plan decides what a prune removes. It is pure so the rules can be
// tested exhaustively; Local executes it. The rules:
//
//   - Only resources labeled seylo.managed=true are candidates (folders:
//     only services/<id> of services this node no longer runs).
//   - Nothing protected (seylo.protected=true) and no infrastructure
//     without a seylo.service label (Traefik, the registry) is touched.
//   - Containers: stopped ones that are one-off job leftovers (cron,
//     backup), belong to a service no longer here, or run an old
//     generation of a service.
//   - Images: per service, keep the ones any container uses, the one the
//     desired spec names and the newest KeepImagesPerService; the rest go.
//   - Volumes, data folders and project networks: only when no service
//     here uses them any more.
//
// Anything that depends on knowing which services belong here is skipped
// while the node has never received a desired state (revision 0), so a
// fresh agent can never mistake every service for an orphan.
func Plan(req *agentv1.PruneRequest, s Snapshot) (items []Item, notes []string) {
	known := s.Desired.GetRevision() > 0
	if !known && (req.GetImages() || req.GetOrphanedServiceData() || req.GetStoppedContainers()) {
		notes = append(notes, "skipped everything that depends on this node's services: no desired state received yet")
	}
	desired := map[string]*agentv1.ServiceSpec{}
	projects := map[string]bool{}
	volumeOwners := map[string]bool{}
	for _, svc := range s.Desired.GetServices() {
		desired[svc.GetId()] = svc
		projects[svc.GetProjectId()] = true
		for _, v := range svc.GetVolumes() {
			if o := v.GetOwnerServiceId(); o != "" {
				volumeOwners[o] = true
			}
		}
	}
	for _, n := range s.Desired.GetNetworks() {
		projects[n.GetProjectId()] = true
	}
	// Services that keep a container of any kind on the node after this
	// prune (containers it removes do not hold their data back).
	removing := map[string]bool{}
	if req.GetStoppedContainers() {
		for _, c := range s.Containers {
			if reason, ok := removableContainer(c, desired, known); ok {
				items = append(items, Item{Kind: KindContainer, ID: c.ID, Name: c.Name, Size: c.SizeRw, Reason: reason})
				removing[c.ID] = true
			}
		}
	}
	withContainers := map[string]bool{}
	for _, c := range s.Containers {
		if id := c.Labels[docker.LabelService]; id != "" && !removing[c.ID] {
			withContainers[id] = true
		}
	}

	if req.GetStoppedContainers() {
		if known {
			for _, n := range s.Networks {
				p, ok := strings.CutPrefix(n.Name, docker.ProjectNetwork(""))
				if !ok || p == "" || projects[p] || !docker.IsManaged(n.Labels) || protected(n.Labels) {
					continue
				}
				items = append(items, Item{Kind: KindNetwork, ID: n.ID, Name: n.Name, Reason: "project has no service on this node"})
			}
		}
	}

	if req.GetImages() && known {
		items = append(items, removableImages(s.Images, s.Containers, desired)...)
	}

	if req.GetOrphanedServiceData() && known {
		for _, v := range s.Volumes {
			svc := v.Labels[docker.LabelService]
			if svc == "" || desired[svc] != nil || volumeOwners[svc] || withContainers[svc] || !docker.IsManaged(v.Labels) || protected(v.Labels) {
				continue
			}
			items = append(items, Item{Kind: KindVolume, ID: v.Name, Name: v.Name, Reason: "service removed from this node"})
		}
		for _, d := range s.ServiceDirs {
			if desired[d.ServiceID] != nil || volumeOwners[d.ServiceID] || withContainers[d.ServiceID] {
				continue
			}
			items = append(items, Item{Kind: KindData, ID: d.Path, Name: d.ServiceID, Size: d.Size, Reason: "service removed from this node"})
		}
	}
	return items, notes
}

func protected(labels map[string]string) bool { return labels[docker.LabelProtected] == "true" }

func removableContainer(c jobrun.Container, desired map[string]*agentv1.ServiceSpec, known bool) (string, bool) {
	if c.Running || !docker.IsManaged(c.Labels) || protected(c.Labels) {
		return "", false
	}
	svc := c.Labels[docker.LabelService]
	if svc == "" {
		return "", false // infrastructure (Traefik, registry)
	}
	switch c.Labels[docker.LabelRole] {
	case jobrun.RoleCron, jobrun.RoleBackup:
		return "finished job container", true
	}
	if !known {
		return "", false
	}
	spec := desired[svc]
	if spec == nil {
		return "service removed from this node", true
	}
	if c.Labels[docker.LabelRole] != "" {
		return "", false // a sleeping helper of a live service (web UI, Box)
	}
	gen, err := strconv.ParseUint(c.Labels[docker.LabelGeneration], 10, 64)
	if err == nil && gen < spec.GetGeneration() {
		return "old generation " + strconv.FormatUint(gen, 10), true
	}
	return "", false
}

func removableImages(images []jobrun.Image, containers []jobrun.Container, desired map[string]*agentv1.ServiceSpec) []Item {
	used := map[string]bool{}
	for _, c := range containers {
		used[c.ImageID] = true
	}
	byService := map[string][]jobrun.Image{}
	for _, img := range images {
		if !docker.IsManaged(img.Labels) || protected(img.Labels) {
			continue
		}
		svc := img.Labels[docker.LabelService]
		if svc == "" {
			continue // ours but not tied to a service (for example infrastructure)
		}
		byService[svc] = append(byService[svc], img)
	}
	var items []Item
	services := make([]string, 0, len(byService))
	for svc := range byService {
		services = append(services, svc)
	}
	sort.Strings(services)
	for _, svc := range services {
		imgs := byService[svc]
		sort.SliceStable(imgs, func(i, j int) bool { return imgs[i].Created.After(imgs[j].Created) })
		spec := desired[svc]
		keep := 0
		if spec != nil {
			keep = KeepImagesPerService
		}
		for i, img := range imgs {
			switch {
			case used[img.ID] || img.Containers > 0:
			case spec != nil && namesImage(spec.GetImage(), img):
			case i < keep:
			default:
				reason := "older than the newest " + strconv.Itoa(keep)
				if spec == nil {
					reason = "service removed from this node"
				}
				items = append(items, Item{Kind: KindImage, ID: img.ID, Name: imageName(img), Size: img.Size, Reason: reason})
			}
		}
	}
	return items
}

// namesImage reports whether the desired image reference or digest points
// at img.
func namesImage(ref *agentv1.ImageRef, img jobrun.Image) bool {
	if d := ref.GetDigest(); d != "" {
		if img.ID == d || slices.ContainsFunc(img.RepoDigests, func(rd string) bool { return strings.HasSuffix(rd, "@"+d) }) {
			return true
		}
	}
	return ref.GetReference() != "" && slices.Contains(img.RepoTags, ref.GetReference())
}

func imageName(img jobrun.Image) string {
	id := strings.TrimPrefix(img.ID, "sha256:")
	if len(id) > 12 {
		id = id[:12]
	}
	if len(img.RepoTags) > 0 && img.RepoTags[0] != "<none>:<none>" {
		return img.RepoTags[0] + " (" + id + ")"
	}
	return id
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
