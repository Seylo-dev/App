// Command seylo is the single Seylo binary: node agent, node CLI and laptop
// CLI. See internal/cli for the command tree.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/seylo-dev/app/go/internal/cli"
)

func main() {
	// SIGTERM is how systemd stops the agent; cancelling the context lets it
	// shut down cleanly while services keep running.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Execute(ctx)
	stop()
	os.Exit(code)
}
