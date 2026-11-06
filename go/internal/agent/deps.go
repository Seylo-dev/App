package agent

import (
	"log/slog"

	"github.com/seylo-dev/app/go/internal/backup"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/cleanup"
	"github.com/seylo-dev/app/go/internal/cron"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/edge"
	"github.com/seylo-dev/app/go/internal/fs"
	"github.com/seylo-dev/app/go/internal/health"
	"github.com/seylo-dev/app/go/internal/logs"
	"github.com/seylo-dev/app/go/internal/metrics"
	"github.com/seylo-dev/app/go/internal/portgate"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/reconcile"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/tunnel"
	"github.com/seylo-dev/app/go/internal/update"
	"github.com/seylo-dev/app/go/internal/wings"
)

// Registry is the agent's AgentService handler registry. Register with
// rpc.HandleUnary, rpc.HandleStream and rpc.HandleRaw.
type Registry = rpc.Mux

// Config is the part of config.yml handlers may read.
type Config struct {
	// NodeID is empty until the node joined a panel.
	NodeID string
	// PanelURL is the panel's base URL, for example "https://panel.example.com".
	PanelURL string
	// PanelPin is config.yml's panel_pin, empty for a panel with a public certificate.
	PanelPin string
	// CanBuild is config.yml's can_build: the owner allows builds here.
	CanBuild bool
	// AcmeCA is config.yml's acme_ca ("staging" or a directory URL).
	AcmeCA string
	// AcmeCACertificates is config.yml's acme_ca_certificates (a PEM file).
	AcmeCACertificates string
	// AcmeCAServerName is config.yml's acme_ca_server_name.
	AcmeCAServerName string
}

// Deps is everything the wiring functions share. The agent fills the
// "core" block before wiring; each area fills its own block in its
// provide function (phase 1), and every block is complete when the wire
// functions run (phase 2). Fields are interfaces from each package's
// doc.go, never concrete types from another area's package.
type Deps struct {
	// Core, set by the agent before wiring.

	Layout datadir.Layout
	Logger *slog.Logger
	Config Config
	// PanelAddress returns the panel URL and pin the agent dials now. It
	// follows a move to the panel's new address (move.go), where Config
	// keeps the values config.yml had at start. Nil in some tests: use
	// panelAddress(d).
	PanelAddress func() (url, pin string)
	// Desired persists the last accepted desired state on disk.
	Desired state.DesiredStore
	// DesiredSync accepts SyncDesired/ApplyService/RemoveService with the
	// revision rules, saves to Desired, then publishes to Feed. Handlers
	// use it instead of calling Desired and Feed themselves. The agent
	// loads the stored state through it at start.
	DesiredSync *state.DesiredSync
	// Feed publishes the accepted desired state (and its NodeSettings) to
	// components that follow it. Reconcile publishes; others subscribe.
	Feed *state.DesiredFeed
	// State is the actual-state store (epoch/seq, snapshot + deltas).
	State state.Store
	// Reports queues durable reports (crashes, final deploy/build results,
	// cron runs, backups, alerts, update results) in the on-disk outbox.
	Reports state.Reporter
	// Events sends best-effort events (progress, metrics, fact changes);
	// dropped while disconnected.
	Events rpc.Emitter
	// Panel calls PanelService over the current connection (UNAVAILABLE
	// while disconnected). PanelPeer is the same link as an rpc.Peer.
	Panel     *rpc.PanelClient
	PanelPeer rpc.Peer
	// Facts are the node facts sent in ClientHello and GetNodeFacts.
	Facts *Facts
	// Components runs background loops and connection hooks.
	Components *Components
	// PanelControl backs `seylo panel start|logs` on the panel's node. Nil
	// until an owner sets it in a wire function; then those commands
	// answer NOT_IMPLEMENTED.
	PanelControl PanelControl

	// Runtime (wire_runtime.go).

	Docker docker.Engine
	Prober health.Prober
	// Reconcile is set in wireRuntime (phase 2), because it needs other
	// owners' components; wire functions after it may use it.
	Reconcile reconcile.Engine

	// Network (wire_network.go).

	Router  proxy.Router
	Gate    portgate.Gate
	Tickets edge.TicketVerifier
	Wings   wings.Detector
	CPU     wings.CPUPriority

	// Build (wire_build.go).

	Builder build.Builder

	// Observe (wire_observe.go).

	Logs    logs.Store
	Metrics metrics.Collector
	Files   fs.Roots

	// Jobs (wire_jobs.go).

	Cron       cron.Scheduler
	Backups    backup.Runner
	Cloudflare tunnel.Cloudflare
	Pruner     cleanup.Pruner
	// CleanupScheduler runs NodeSettings.cleanup; the node area feeds it
	// the disk checks' readings.
	CleanupScheduler cleanup.Scheduler

	// Node (wire_node.go).

	Updater update.Updater
}

// panelAddress is d.PanelAddress, or Config's values without it.
func panelAddress(d *Deps) (url, pin string) {
	if d.PanelAddress != nil {
		return d.PanelAddress()
	}
	return d.Config.PanelURL, d.Config.PanelPin
}
