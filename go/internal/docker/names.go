package docker

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Names of shared infrastructure. Part of the on-node contract, like labels.
const (
	// EdgeNetwork connects Traefik to every routed container.
	EdgeNetwork = brand.Slug + "-edge"
	// CgroupParent is the systemd slice all our containers run under.
	CgroupParent = brand.Slug + ".slice"
	// TraefikContainer is the agent-owned Traefik (not used next to Wings,
	// where the fork's Traefik reads our route files).
	TraefikContainer = brand.Slug + "-traefik"
	// RouteFilePrefix starts every Traefik route file we write. The Wings
	// fork skips files with this prefix when it prunes its own routes.
	RouteFilePrefix = brand.Slug + "-"
)

// RegistryRelayAddress is where Docker on every node reaches the panel
// registry (the agent's relay, registry.LocalAddress). Images built here
// are <RegistryRelayAddress>/<service id>.
const RegistryRelayAddress = "127.0.0.1:5755"

// BridgeNameOption is the Docker network option that names a bridge's
// host interface.
const BridgeNameOption = "com.docker.network.bridge.name"

// NetworkOptions are the driver options every network we create gets.
// A name that fits a Linux interface name (15 characters, like
// seylo-edge) names the bridge after the network, so firewall rules can
// name it (the installer's "ufw allow in on seylo-edge ..."). Every
// component that may create a network passes these, so whichever creates
// it first makes the same network.
func NetworkOptions(name string) map[string]string {
	if len(name) > 15 {
		return nil
	}
	return map[string]string{BridgeNameOption: name}
}

// Reserved ids of the Panel project and its panel service. The installer
// starts the first panel container under them and the panel names its own
// rows with them, so the agent adopts that container. Part of the on-node
// contract.
const (
	PanelProjectID = "panelproject0000"
	PanelServiceID = "panel00000000000"
)

// The panel container's user (uid and gid), part of the on-node contract
// like the reserved ids. It owns <dataDir>/panel (mode 0700), where
// master.key and panel.db live. useradd hands out 1000-60000 to people, so
// no login user has it; systemd keeps 60578-61183 unused, so no system
// service does either. Before 0.2.0-rc.2 the panel ran as the image's uid
// 1000, which on most cloud images is the default login user (ubuntu,
// debian, ec2-user): that user could read master.key without sudo. The
// agent moves an existing folder to this user before it starts a panel
// container (reconcile); deploy/panel.Dockerfile builds the same number in
// (ARG PANEL_UID).
const (
	PanelUID = 61000
	PanelGID = 61000
)

// PanelUser is the panel container's --user.
var PanelUser = fmt.Sprintf("%d:%d", PanelUID, PanelGID)

// PanelIDHolders names the entries in <etcDir>/passwd and <etcDir>/group
// that have the panel's uid or gid, as "user <name>" and "group <name>".
// Such an account owns the panel's folder, so it can read master.key and
// panel.db. The installer's check_panel_uid warns about the same thing
// with getent on a new install; reconcile and the node health check use
// this on every node, upgrades included. Only the files are read (the
// agent is built without cgo, like os/user then): accounts from a
// directory service are not seen. A file that cannot be read has no
// entries.
func PanelIDHolders(etcDir string) []string {
	var out []string
	for _, db := range []struct {
		file, kind string
		id         int
	}{{"passwd", "user", PanelUID}, {"group", "group", PanelGID}} {
		data, err := os.ReadFile(filepath.Join(etcDir, db.file))
		if err != nil {
			continue
		}
		id := strconv.Itoa(db.id)
		for line := range strings.SplitSeq(string(data), "\n") {
			fields := strings.Split(strings.TrimSpace(line), ":")
			if len(fields) < 3 || fields[0] == "" || strings.HasPrefix(fields[0], "#") {
				continue
			}
			if fields[2] == id {
				out = append(out, db.kind+" "+fields[0])
			}
		}
	}
	return out
}

// IsPanelService reports whether a service is the protected panel itself.
func IsPanelService(serviceID string, protected bool) bool {
	return protected && serviceID == PanelServiceID
}

// ContainerName is the name of one instance: seylo-<service>-<generation>,
// with a replica suffix from the second replica on so single-replica
// services keep the short name people see in `docker ps`.
func ContainerName(serviceID string, generation uint64, replica uint32) string {
	if replica == 0 {
		return fmt.Sprintf("%s-%s-%d", brand.Slug, serviceID, generation)
	}
	return fmt.Sprintf("%s-%s-%d-%d", brand.Slug, serviceID, generation, replica)
}

// ProjectNetwork is the private network of a project. Projects are
// isolated from each other by having separate networks.
func ProjectNetwork(projectID string) string {
	return brand.Slug + "-p-" + projectID
}

// VolumeName is the Docker volume backing one service volume. owner is the
// service whose folder holds it (VolumeMount.owner_service_id or the
// service itself).
func VolumeName(owner, volume string) string {
	return fmt.Sprintf("%s-v-%s-%s", brand.Slug, owner, volume)
}

// RouteFile is the Traefik dynamic config file name of a service.
func RouteFile(serviceID string) string {
	return RouteFilePrefix + serviceID + ".yml"
}
