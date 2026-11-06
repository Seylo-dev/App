package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/version"
)

func newVersionCommand(d *deps) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the version (and the running agent's, on a node)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if _, err := fmt.Fprintf(d.out, "%s %s\n", brand.Slug, version.String()); err != nil {
				return err
			}
			client := localapi.NewClient(d.layout)
			if !localapi.Available(client.Socket()) {
				return nil
			}
			if v, err := client.Version(cmd.Context()); err == nil && v.Version != version.Version {
				fmt.Fprintf(d.out, "running agent: %s\n", v.Version)
			}
			return nil
		},
	}
}
