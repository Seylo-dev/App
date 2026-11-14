package datadir

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Layout resolves paths under one data dir root.
type Layout struct {
	root string
}

// Default is the layout under brand.DataDir.
func Default() Layout {
	return Layout{root: brand.DataDir}
}

// New returns a layout under root, for tests and non-standard installs.
func New(root string) Layout {
	return Layout{root: filepath.Clean(root)}
}

// Root is the data dir itself.
func (l Layout) Root() string { return l.root }

// ConfigFile is the node config.
func (l Layout) ConfigFile() string { return filepath.Join(l.root, "config.yml") }

// AgentKey is the agent's Ed25519 private key.
func (l Layout) AgentKey() string { return filepath.Join(l.root, "agent.key") }

// AgentSocket is the local API socket the node CLI talks to.
func (l Layout) AgentSocket() string { return filepath.Join(l.root, "run", "agent.sock") }

// StateDir holds the persisted desired state, actual-state store and outbox.
func (l Layout) StateDir() string { return filepath.Join(l.root, "state") }

// PanelDatabase is the panel's SQLite file on the panel node.
func (l Layout) PanelDatabase() string { return filepath.Join(l.root, "panel", "panel.db") }

// BuildsDir holds build workspaces and uploaded build contexts.
func (l Layout) BuildsDir() string { return filepath.Join(l.root, "builds") }

// BuildsDockerConfig is DOCKER_CONFIG for every docker command of a build
// (internal/build: <BuildsDir>/docker). The docker CLI then finds plugins in
// its cli-plugins and the system plugin folders, never in root's
// ~/.docker/cli-plugins. The buildx facts and the buildx health check run
// with it too, so they see what builds see.
func (l Layout) BuildsDockerConfig() string { return filepath.Join(l.BuildsDir(), "docker") }

// BackupSpoolDir holds what a backup's upload has not taken yet
// (internal/backup spool): files removed from the folder as soon as they
// are created, so it is normally empty; the agent empties it at start.
func (l Layout) BackupSpoolDir() string { return filepath.Join(l.root, "backup-spool") }

// ToolsDir holds pinned helper binaries (Railpack, Nixpacks).
func (l Layout) ToolsDir() string { return filepath.Join(l.root, "tools") }

// RegistryDir holds the image registry's storage on the panel node.
func (l Layout) RegistryDir() string { return filepath.Join(l.root, "registry") }

// NetworkDir holds networking state (the portgate's remembered ports).
func (l Layout) NetworkDir() string { return filepath.Join(l.root, "network") }

// TraefikDir holds the agent-owned Traefik's static and dynamic config.
func (l Layout) TraefikDir() string { return filepath.Join(l.root, "traefik") }

// ErrInvalidID means an id would escape its folder or is not one we issue.
var ErrInvalidID = errors.New("datadir: invalid id")

// Ids come from the panel and from volume names typed by users; they become
// path segments, so anything outside this set is rejected rather than
// cleaned.
var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

func checkID(kind, id string) error {
	if !idRe.MatchString(id) {
		return fmt.Errorf("%w: %s %q", ErrInvalidID, kind, id)
	}
	return nil
}

// ServicesDir holds one folder per service (ServiceDir). It and every
// service folder are private to root (PrivateDirMode, services.go).
func (l Layout) ServicesDir() string { return filepath.Join(l.root, "services") }

// ServiceDir is the folder of one service.
func (l Layout) ServiceDir(serviceID string) (string, error) {
	if err := checkID("service", serviceID); err != nil {
		return "", err
	}
	return filepath.Join(l.ServicesDir(), serviceID), nil
}

// ServiceVolume is the backing folder of one service volume.
func (l Layout) ServiceVolume(serviceID, volume string) (string, error) {
	dir, err := l.ServiceDir(serviceID)
	if err != nil {
		return "", err
	}
	if err := checkID("volume", volume); err != nil {
		return "", err
	}
	return filepath.Join(dir, "volumes", volume), nil
}

// ServiceFiles is the folder holding a service's file mounts.
func (l Layout) ServiceFiles(serviceID string) (string, error) {
	dir, err := l.ServiceDir(serviceID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "files"), nil
}

// ServiceLogs is the folder of a service's log files.
func (l Layout) ServiceLogs(serviceID string) (string, error) {
	if err := checkID("service", serviceID); err != nil {
		return "", err
	}
	return filepath.Join(l.root, "logs", serviceID), nil
}
