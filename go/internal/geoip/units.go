package geoip

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/systemd"
)

// The lookup server's systemd units. The socket unit holds the port: the
// server gets the listening socket from systemd (Listener), so while it
// restarts (a crash, a new protocol, a new database location) connections
// wait in the socket's queue instead of being refused, and FreeBind lets
// the socket bind the edge gateway's address at boot before Docker made
// the bridge. The service runs apart from the agent's unit: an agent
// restart or crash leaves it serving.
const (
	SocketUnit  = brand.Slug + "-geoip.socket"
	ServiceUnit = brand.Slug + "-geoip.service"
)

// SocketUnitFile renders the socket unit listening on listen
// ("172.30.0.1:5758").
func SocketUnitFile(listen string) string {
	return fmt.Sprintf(`# Written by the %[1]s agent while the visitor country header is on; do not edit.
[Unit]
Description=%[1]s visitor country lookup (socket)
Documentation=%[2]s

[Socket]
ListenStream=%[3]s
FreeBind=yes
NoDelay=yes
Backlog=4096

[Install]
WantedBy=sockets.target
`, brand.DisplayName, brand.DocsURL, listen)
}

// ServiceUnitFile renders the service unit: binary serves the database at
// dbPath on the socket. It needs no network of its own (the socket is
// handed in), no privileges and no writes.
func ServiceUnitFile(binary, dbPath string) string {
	return fmt.Sprintf(`# Written by the %[1]s agent while the visitor country header is on; do not edit.
[Unit]
Description=%[1]s visitor country lookup
Documentation=%[2]s
Requires=%[3]s
After=%[3]s
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=%[4]s geoip serve --db %[5]s
Restart=always
RestartSec=1
TimeoutStopSec=15
NoNewPrivileges=yes
CapabilityBoundingSet=
PrivateNetwork=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=512M
LimitNOFILE=65536
`, brand.DisplayName, brand.DocsURL, SocketUnit, binary, dbPath)
}

// Units keeps the two units in Dir (systemd.UnitDir).
type Units struct {
	Dir string
	Run systemd.Runner
}

func (u Units) systemctl(ctx context.Context, args ...string) error {
	return u.Run(ctx, io.Discard, "systemctl", args...)
}

// Installed reports whether the socket unit file is there.
func (u Units) Installed() bool {
	_, err := os.Stat(filepath.Join(u.Dir, SocketUnit))
	return err == nil
}

// Ensure writes the units when they differ from what is there, reloads
// systemd, and makes sure the socket listens: a new socket file restarts
// the socket (and stops the service, which takes the new socket at its
// next start), a new service file restarts the service. changed says a
// file was written.
func (u Units) Ensure(ctx context.Context, listen, binary, dbPath string) (changed bool, err error) {
	if err := os.MkdirAll(u.Dir, 0o755); err != nil {
		return false, err
	}
	socketChanged, err := writeIfChanged(filepath.Join(u.Dir, SocketUnit), SocketUnitFile(listen))
	if err != nil {
		return false, err
	}
	serviceChanged, err := writeIfChanged(filepath.Join(u.Dir, ServiceUnit), ServiceUnitFile(binary, dbPath))
	if err != nil {
		return socketChanged, err
	}
	changed = socketChanged || serviceChanged
	if changed {
		if err := u.systemctl(ctx, "daemon-reload"); err != nil {
			return changed, err
		}
	}
	if socketChanged {
		if err := u.systemctl(ctx, "stop", ServiceUnit); err != nil {
			return changed, err
		}
		if err := u.systemctl(ctx, "enable", SocketUnit); err != nil {
			return changed, err
		}
		if err := u.systemctl(ctx, "restart", SocketUnit); err != nil {
			return changed, err
		}
	} else if serviceChanged {
		if err := u.systemctl(ctx, "try-restart", ServiceUnit); err != nil {
			return changed, err
		}
	}
	// Idempotent: also brings back a socket someone stopped.
	if err := u.systemctl(ctx, "enable", "--now", SocketUnit); err != nil {
		return changed, err
	}
	return changed, nil
}

// RestartService restarts the server (the socket keeps listening).
func (u Units) RestartService(ctx context.Context) error {
	return u.systemctl(ctx, "restart", ServiceUnit)
}

// Remove stops and disables both units and deletes their files.
func (u Units) Remove(ctx context.Context) error {
	var errs []error
	if u.Installed() {
		if err := u.systemctl(ctx, "disable", "--now", SocketUnit, ServiceUnit); err != nil {
			errs = append(errs, err)
		}
	}
	removed := false
	for _, name := range []string{SocketUnit, ServiceUnit} {
		err := os.Remove(filepath.Join(u.Dir, name))
		switch {
		case err == nil:
			removed = true
		case !errors.Is(err, os.ErrNotExist):
			errs = append(errs, err)
		}
	}
	if removed {
		if err := u.systemctl(ctx, "daemon-reload"); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func writeIfChanged(path, content string) (bool, error) {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, []byte(content)) {
		return false, nil
	}
	return true, writeAtomic(path, []byte(content), 0o644)
}
