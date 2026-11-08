package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/localapi"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
)

// Options configures the daemon.
type Options struct {
	Layout datadir.Layout
	Logger *slog.Logger
	// Join, when set, writes config.yml for a new node before starting
	// (`seylo agent --join <url> --token <t> [--pin <spki>]`).
	Join *JoinOptions
}

// JoinOptions are the join command's flags.
type JoinOptions struct {
	// PanelURL is the panel's base URL.
	PanelURL string
	// Token is the single-use join token from "Add node".
	Token string
	// Pin is the panel certificate's SPKI SHA-256 ("sha256:<hex>"); empty
	// for a panel with a public certificate.
	Pin string
	// TrustOnFirstUse pins whatever certificate the panel presents on the
	// first connection. The join command sets it only when the panel has
	// neither a public certificate nor a pin to hand out.
	TrustOnFirstUse bool
	// Name proposed for the node; empty keeps config.yml's node_name (the
	// hostname when there is none).
	Name string
	// CanBuild allows (true) or stops (false) builds on this node; nil
	// keeps config.yml's can_build (off for a new node).
	CanBuild *bool
	// Force replaces the config of a node that already joined a panel.
	Force bool
	// Insecure accepts a plain http:// panel URL on another host
	// (FileConfig.InsecureTransport).
	Insecure bool
}

// ErrAlreadyJoined means config.yml already holds a node id.
var ErrAlreadyJoined = errors.New("agent: this node already joined a panel")

// Join writes config.yml for a node that joins with a token. It does not
// connect; Run does, and records the node id once the panel accepted it.
//
// A node that joins again (--force) keeps what its owner set in
// config.yml: no_host_shell, node_name, can_build, the acme_ca settings
// and every key this agent does not know. Join replaces only how the node
// reaches the panel (panel_url, panel_pin, trust_on_first_use,
// insecure_transport, fallback), the identity the token gives it (node_id,
// join_token) and the identity of the panel it belonged to (panel_id,
// panel_key, panel_proves); node_name and can_build change only when
// --name or --can-build say so.
func Join(layout datadir.Layout, opts JoinOptions) error {
	if opts.Token == "" {
		return errors.New("a join token is required")
	}
	if old, err := LoadConfig(layout.ConfigFile()); err == nil && old.NodeID != "" && !opts.Force {
		return fmt.Errorf("%w (node %s at %s); pass --force to join again", ErrAlreadyJoined, old.NodeID, old.PanelURL)
	}
	cfg := &FileConfig{}
	if prev := readConfigLoose(layout.ConfigFile()); prev != nil {
		cfg = prev
	}
	cfg.PanelURL, cfg.PanelPin, cfg.TrustOnFirstUse = opts.PanelURL, "", opts.TrustOnFirstUse
	// Only recorded when it matters, so a later move to https:// drops it.
	cfg.InsecureTransport = opts.Insecure && PlainRemote(opts.PanelURL)
	cfg.Fallback = nil
	cfg.NodeID, cfg.JoinToken = "", opts.Token
	cfg.PanelID, cfg.PanelKey, cfg.PanelProves = "", "", false
	if opts.Name != "" {
		cfg.NodeName = opts.Name
	}
	if opts.CanBuild != nil {
		cfg.CanBuild = *opts.CanBuild
	}
	if opts.Pin != "" {
		pin, err := conn.ParsePin(opts.Pin)
		if err != nil {
			return err
		}
		cfg.PanelPin = conn.FormatPin(pin)
		cfg.TrustOnFirstUse = false
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(layout.Root(), 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", layout.Root(), err)
	}
	return SaveConfig(layout.ConfigFile(), cfg)
}

// Run starts the agent and blocks until ctx is cancelled (SIGTERM from
// systemd) or a fatal startup error occurs.
//
// Order: write config.yml when joining; load config.yml and the agent key
// (created on first start); open the outbox and the desired store, and
// publish the stored desired state to the feed; Wire (every owner's
// provide, then wire); start Components and the local API; then keep the
// panel connection up (dial, handshake, serve, back off, redial). Services
// keep running while the panel is away. On shutdown every loop sees ctx
// end and Run returns once they stopped.
func Run(ctx context.Context, opts Options) error {
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	layout := opts.Layout
	if layout.Root() == "" {
		layout = datadir.Default()
	}
	if opts.Join != nil {
		if err := Join(layout, *opts.Join); err != nil {
			return err
		}
		logger.Info("wrote the node config; joining the panel", "panel_url", opts.Join.PanelURL)
	}
	a, err := newDaemon(ctx, layout, logger)
	if err != nil {
		return err
	}
	return a.run(ctx)
}

// daemon is one running agent: Deps, registry and the loops around them.
type daemon struct {
	layout  datadir.Layout
	logger  *slog.Logger
	deps    *Deps
	reg     *Registry
	conn    *connector
	backend *localBackend
}

func newDaemon(ctx context.Context, layout datadir.Layout, logger *slog.Logger) (*daemon, error) {
	cfgPath := layout.ConfigFile()
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		return nil, err
	}
	for _, dir := range []string{layout.Root(), layout.StateDir(), filepath.Dir(layout.AgentSocket())} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	// services/ and services/<id>/ hold file mounts and volume data; agents
	// before 0.2.0-rc.2 made them 0755 under the 0711 data dir.
	if err := layout.SecureServiceDirs(); err != nil {
		logger.Warn("closing the service folders to other accounts", "err", err)
	}
	key, err := loadOrCreateKey(layout.AgentKey())
	if err != nil {
		return nil, err
	}
	outbox, err := state.OpenFileOutbox(filepath.Join(layout.StateDir(), "outbox"), state.OutboxOptions{Logger: logger})
	if err != nil {
		return nil, err
	}

	link := rpc.NewLink()
	wake := make(chan struct{}, 1)
	feed := state.NewDesiredFeed()
	desiredStore := state.NewFileDesiredStore(filepath.Join(layout.StateDir(), "desired.pb"))
	desired := state.NewDesiredSync(desiredStore, feed)
	if err := desired.Load(ctx); err != nil {
		if !errors.Is(err, state.ErrCorruptDesired) {
			return nil, err
		}
		logger.Error("the stored desired state was unreadable; waiting for the panel to send it again", "err", err)
	}
	store := state.NewMemoryStore()

	d := &Deps{
		Layout:      layout,
		Logger:      logger,
		Config:      Config{NodeID: cfg.NodeID, PanelURL: cfg.PanelURL, PanelPin: cfg.PanelPin, CanBuild: cfg.CanBuild, AcmeCA: cfg.AcmeCA, AcmeCACertificates: cfg.AcmeCACertificates, AcmeCAServerName: cfg.AcmeCAServerName, NoHostShell: cfg.NoHostShell, GitProxyResolves: cfg.GitProxyResolves},
		Desired:     desiredStore,
		DesiredSync: desired,
		Feed:        feed,
		State:       store,
		Reports: &state.OutboxReporter{Outbox: outbox, Wake: func() {
			select {
			case wake <- struct{}{}:
			default:
			}
		}},
		Events:     link,
		Panel:      rpc.NewPanelClient(link),
		PanelPeer:  link,
		Facts:      NewFacts(link),
		Components: &Components{},
	}
	d.Config.NoTailnet, d.Config.TailscaleSocket = cfg.NoTailnet, cfg.TailscaleSocket
	d.Facts.Update(func(f *agentv1.NodeFacts) {
		collectMachineFacts(f, layout.Root())
		f.CanBuild = cfg.CanBuild
	})
	reg, err := Wire(d)
	if err != nil {
		return nil, err
	}
	// Actual-state changes go to the panel as they happen; a dropped delta
	// shows up as a seq gap and the panel fetches a snapshot.
	store.Subscribe(func(delta *agentv1.StateDelta) {
		link.Emit(&agentv1.Event{Payload: &agentv1.Event_StateDelta{StateDelta: delta}})
	})
	d.Components.Add("machine-facts", func(ctx context.Context) error {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				d.Facts.Update(func(f *agentv1.NodeFacts) { refreshVolatileFacts(f, layout.Root()) })
			case <-ctx.Done():
				return nil
			}
		}
	})

	c := &connector{
		deps: d, reg: reg, link: link, key: key, outbox: outbox, desired: desired,
		status: &statusTracker{}, logger: logger, wake: wake,
		cfgPath: cfgPath, cfg: cfg,
		clock:   &clockWatch{reports: func() state.Reporter { return d.Reports }, logger: logger},
		rootCAs: panelRoots,
	}
	// Set before any loop runs; the address follows moves (move.go).
	d.PanelAddress = func() (string, string) {
		cfg := c.config()
		return cfg.PanelURL, cfg.PanelPin
	}
	return &daemon{
		layout: layout, logger: logger, deps: d, reg: reg, conn: c,
		backend: &localBackend{deps: d, conn: c, desired: desired, outbox: outbox, started: time.Now()},
	}, nil
}

func (a *daemon) run(ctx context.Context) error {
	a.logger.Info("agent starting", "node_id", a.deps.Config.NodeID, "panel_url", a.deps.Config.PanelURL,
		"capabilities", len(a.reg.Capabilities()), "desired_revision", a.deps.DesiredSync.Revision())
	var wg sync.WaitGroup
	wg.Go(func() { a.deps.Components.run(ctx, a.logger) })
	wg.Go(func() {
		socket := a.layout.AgentSocket()
		for ctx.Err() == nil {
			err := localapi.Serve(ctx, socket, a.backend, a.logger)
			if err == nil || ctx.Err() != nil {
				return
			}
			a.logger.Error("local API stopped; restarting it", "socket", socket, "err", err)
			sleepCtx(ctx, 5*time.Second)
		}
	})
	wg.Go(func() { _ = a.conn.run(ctx) })
	wg.Wait()
	a.logger.Info("agent stopped")
	return nil
}
