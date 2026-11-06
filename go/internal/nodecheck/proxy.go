package nodecheck

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// traefikDynamicDir is where the agent's own Traefik reads route files.
func (e *Env) traefikDynamicDir(ctx context.Context) (dir string, shared bool) {
	if e.Wings != nil {
		if info, err := e.Wings(ctx); err == nil && info.GetTraefikDynamicDir() != "" {
			return info.GetTraefikDynamicDir(), true
		}
	}
	return filepath.Join(e.DataDir, "traefik", "dynamic"), false
}

// proxyRunning: our Traefik container runs (or the Wings fork's proxy is
// used instead).
func (e *Env) proxyRunning(ctx context.Context) *agentv1.NodeCheckResult {
	if _, shared := e.traefikDynamicDir(ctx); shared {
		return pass("routes go to the Wings fork's Traefik")
	}
	list, err := e.Docker.Containers(ctx, map[string][]string{"name": {"^" + docker.TraefikContainer + "$"}})
	if err != nil {
		return skipped("Docker is not reachable")
	}
	for _, c := range list {
		if c.Name() == docker.TraefikContainer {
			if c.State == "running" {
				return pass("%s is %s", c.Name(), strings.ToLower(c.Status))
			}
			return fail(fmt.Sprintf("%s is %s", c.Name(), c.State),
				"Restart the agent (`"+brand.Slug+" restart`); it starts the proxy again. Its logs: `docker logs "+docker.TraefikContainer+"`.")
		}
	}
	return warn("the proxy container does not exist yet",
		"The agent creates it with the first domain or published port; if services have domains, check `"+brand.Slug+" logs`.")
}

// routeFiles: every route file parses. Traefik drops the whole folder
// when one file is broken, so one bad file takes every domain down.
func (e *Env) routeFiles(ctx context.Context) *agentv1.NodeCheckResult {
	dir, _ := e.traefikDynamicDir(ctx)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return pass("no route files yet")
	}
	if err != nil {
		return warn("could not read "+dir+": "+err.Error(), "")
	}
	var bad []string
	n := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, docker.RouteFilePrefix) || !strings.HasSuffix(name, ".yml") {
			continue
		}
		n++
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			bad = append(bad, name+" (unreadable)")
			continue
		}
		var doc map[string]any
		if err := yaml.Unmarshal(data, &doc); err != nil {
			bad = append(bad, name)
		}
	}
	if len(bad) > 0 {
		return fail(fmt.Sprintf("%d of %d route files do not parse: %s", len(bad), n, strings.Join(bad, ", ")),
			"Restart the agent so it rewrites them, and send `"+brand.Slug+" troubleshoot` if it keeps happening.")
	}
	return pass("%d route files parse", n)
}
