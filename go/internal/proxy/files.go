// Atomic route file writes, ported from the Wings fork's proxy/routes.go
// (MIT, see the notice in dynamic.go).

package proxy

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/seylo-dev/app/go/internal/docker"
)

// routeFileMode keeps route files root-only: they can hold custom
// certificate keys and the probe secret. Traefik runs as root.
const routeFileMode = 0o600

// writeAtomic puts data at dir/name through a temporary file and a rename,
// so a watching Traefik never reads half a file. An identical file is left
// alone. The temporary name starts with the route prefix (so the Wings
// fork's prune skips it) and does not end in .yml (so Traefik skips it).
func writeAtomic(dir, name string, data []byte) error {
	target := filepath.Join(dir, name)
	if current, err := os.ReadFile(target); err == nil && bytes.Equal(current, data) {
		return nil
	}
	tmp, err := os.CreateTemp(dir, "."+name+".*.tmp")
	if err != nil {
		return fmt.Errorf("creating route file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing route file: %w", err)
	}
	if err := tmp.Chmod(routeFileMode); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing route file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("writing route file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("writing route file: %w", err)
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		return fmt.Errorf("switching route file: %w", err)
	}
	return nil
}

func removeFile(dir, name string) error {
	if err := os.Remove(filepath.Join(dir, name)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("removing route file: %w", err)
	}
	return nil
}

// ownedFiles lists the route files and leftover temp files of ours in dir:
// seylo-<id>.yml and .seylo-<id>.yml.*.tmp. Files of anyone else (the
// Wings fork's own routes) are never returned.
func ownedFiles(dir string) (routes map[string]string, temps []string, err error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil, nil
		}
		return nil, nil, fmt.Errorf("listing route files: %w", err)
	}
	routes = map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			continue
		}
		if strings.HasPrefix(name, "."+docker.RouteFilePrefix) && strings.HasSuffix(name, ".tmp") {
			temps = append(temps, name)
			continue
		}
		if strings.HasPrefix(name, docker.RouteFilePrefix) && strings.HasSuffix(name, ".yml") {
			id := strings.TrimSuffix(strings.TrimPrefix(name, docker.RouteFilePrefix), ".yml")
			if idPattern.MatchString(id) {
				routes[id] = name
			}
		}
	}
	return routes, temps, nil
}
