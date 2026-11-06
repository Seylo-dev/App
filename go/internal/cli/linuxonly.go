package cli

import (
	"fmt"
	"runtime"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/panelapi"
)

// anyOSAnnotation marks a node command that checks the OS itself (part of
// it works from a laptop, like `logs <project/service>`).
const anyOSAnnotation = "seylo.any-os"

// serviceLogs prints a service's logs through the panel (the laptop half of `logs`).
func serviceLogs(cmd *cobra.Command, d *deps, ref string, tail int, follow bool) error {
	c, err := d.client()
	if err != nil {
		return err
	}
	return c.ServiceLogs(cmd.Context(), panelapi.ServiceRef(ref), panelapi.LogsOptions{Tail: tail, Follow: follow}, d.out)
}

// errLinuxOnly is what node commands answer off Linux.
func errLinuxOnly(name string) error {
	return fmt.Errorf("`%s %s` runs on a Linux server (this is the %s/%s build: use the panel commands, see `%s --help`)",
		brand.Slug, name, runtime.GOOS, runtime.GOARCH, brand.Slug)
}

// trimRoot drops the root command's name from a command path.
func trimRoot(path string) string {
	if i := len(brand.Slug) + 1; len(path) > i && path[:i] == brand.Slug+" " {
		return path[i:]
	}
	return path
}
