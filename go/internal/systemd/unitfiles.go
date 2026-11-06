package systemd

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// SliceUnit is the cgroup slice every service container runs in
// (docker --cgroup-parent). "Game servers first" lowers its CPUWeight.
const SliceUnit = brand.Slug + ".slice"

// DefaultBinary is where the installer puts the agent binary.
const DefaultBinary = "/usr/local/bin/" + brand.Slug

// UnitDir is where the installer writes the units.
const UnitDir = "/etc/systemd/system"

// AgentUnitFile renders seylo.service for the binary at binary.
//
// The agent runs in system.slice, not in seylo.slice, so lowering the
// services' CPU weight never slows the agent down. Restart=always keeps it
// up; a crash loop backs off instead of hitting the start limit, so the
// update guard can still restore an older binary.
func AgentUnitFile(binary, dataDir string) string {
	return fmt.Sprintf(`# Written by the %[1]s installer. Changes are overwritten on reinstall;
# use "systemctl edit %[2]s" for local overrides.
[Unit]
Description=%[1]s node agent
Documentation=%[3]s
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=%[4]s agent --data-dir %[5]s
Restart=always
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=1048576
OOMScoreAdjust=-500
Environment=GOTRACEBACK=crash

[Install]
WantedBy=multi-user.target
`, brand.DisplayName, AgentUnit, brand.DocsURL, binary, dataDir)
}

// SliceUnitFile renders seylo.slice.
func SliceUnitFile() string {
	return fmt.Sprintf(`# Written by the %[1]s installer.
[Unit]
Description=%[1]s services
Documentation=%[2]s
Before=slices.target

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes
TasksAccounting=yes
CPUWeight=100
`, brand.DisplayName, brand.DocsURL)
}

// InstallUnits writes both units into dir and, unless reload is nil, runs
// `systemctl daemon-reload` when anything changed. It reports whether a
// file changed.
func InstallUnits(ctx context.Context, dir, binary, dataDir string, run Runner) (changed bool, err error) {
	files := map[string]string{
		AgentUnit: AgentUnitFile(binary, dataDir),
		SliceUnit: SliceUnitFile(),
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, []byte(content)) {
			continue
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
			return changed, err
		}
		if err := os.Rename(tmp, path); err != nil {
			return changed, err
		}
		changed = true
	}
	if changed && run != nil {
		if err := run(ctx, io.Discard, "systemctl", "daemon-reload"); err != nil {
			return changed, err
		}
	}
	return changed, nil
}

// RemoveUnits deletes both units from dir (uninstall).
func RemoveUnits(dir string) error {
	var errs []string
	for _, name := range []string{AgentUnit, SliceUnit} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
			errs = append(errs, err.Error())
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("removing units: %s", strings.Join(errs, "; "))
	}
	return nil
}
