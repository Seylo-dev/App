package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/version"
)

// Connection timing. Variables so tests can shorten them.
var (
	dialTimeout      = 20 * time.Second
	handshakeTimeout = 20 * time.Second
	reconnectMin     = time.Second
	reconnectMax     = time.Minute
	// rejectedRetry is the wait after the panel refused the agent for a
	// reason only a person can fix (bad token, removed node, pin mismatch).
	rejectedRetry = 5 * time.Minute
	// stableAfter resets the backoff once a connection lasted this long.
	stableAfter = time.Minute
	// drainRetryMax caps the wait between failed report deliveries.
	drainRetryMax = time.Minute
	// panelCallTimeout bounds each report delivery and the desired-state
	// fetch: the WebSocket ping is answered outside the panel's event loop,
	// so a wedged handler would otherwise hold the drain for the whole
	// connection.
	panelCallTimeout = 30 * time.Second
	// drainTimeoutsToAbort consecutive delivery timeouts drop the
	// connection, so the agent reconnects to a panel that stopped working.
	drainTimeoutsToAbort = 3
	// configSaveRetry is how often a config.yml that could not be written
	// is tried again.
	configSaveRetry = 30 * time.Second
	// pingEvery and pingTimeout detect a panel that vanished without
	// closing the connection.
	pingEvery   = 30 * time.Second
	pingTimeout = 15 * time.Second
)

// connector keeps the panel connection up: dial, handshake, serve, back
// off, redial. Services keep running while it is down.
type connector struct {
	deps    *Deps
	reg     *Registry
	link    *rpc.Link
	key     ed25519.PrivateKey
	outbox  state.Outbox
	desired *state.DesiredSync
	status  *statusTracker
	logger  *slog.Logger
	// wake nudges the outbox drain (buffer 1, never blocks).
	wake chan struct{}
	// clock raises CLOCK_SKEW from the offset each session measures.
	clock *clockWatch

	cfgPath string
	cfgMu   sync.Mutex
	cfg     *FileConfig
	// cfgUnsaved: the in-memory config holds what a handshake taught us
	// (node id, pin) but config.yml could not be written yet.
	cfgUnsaved bool

	// sessionURL is the address of the session being served ("" between
	// sessions), under cfgMu: StagePanelAddress refuses a plain-HTTP one.
	sessionURL string

	// The rest belongs to the run goroutine (move.go).
	// useFallback makes the next attempt dial config.yml's fallback.
	useFallback bool
	// useStaged makes the next attempt dial config.yml's staged address
	// (panel_stage.go).
	useStaged bool
	// stagedHeld is the move whose staged address waits for its switch on
	// this node (stagedWaits), logged once.
	stagedHeld string
	// primaryDown is when connects to panel_url started failing (zero
	// while they work); standingTried is the last standing fallback dial.
	primaryDown, standingTried time.Time
	// moveRetry holds when a failed move to an address may be tried again.
	moveRetry map[string]time.Time
	// moveAlerted is the address the last PANEL_MOVE_FAILED alert named.
	moveAlerted string
	// plainMoveWarned: a plain-HTTP session's panel_url was ignored and
	// logged once.
	plainMoveWarned bool
	// rootCAs verifies panels without a pin; nil means the system roots.
	rootCAs *x509.CertPool
}

func (c *connector) config() FileConfig {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	return *c.cfg
}

// run loops until ctx ends.
func (c *connector) run(ctx context.Context) error {
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		c.status.connecting()
		err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(started) >= stableAfter {
			attempt = 0
		}
		attempt++
		delay := backoff(attempt)
		var rejected *rpc.RejectedError
		switch {
		case errors.Is(err, errMoveFailed):
			// Back to the old address at once; the move waits for its retry.
			delay = reconnectMin
			c.status.failed("waiting", err, delay)
		case errors.As(err, &rejected) && rejected.Rejected.GetReason() == agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD:
			delay = rejectedRetry
			c.status.failed("rejected", err, delay)
			c.selfUpdate(ctx, rejected.Rejected.GetMinAgentVersion())
		case errors.As(err, &rejected) && rejected.Rejected.GetReason() != agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED:
			delay = rejectedRetry
			c.logger.Error("the panel refused this agent; fix the node config or join again", "reason", rejected.Rejected.GetReason().String(), "message", rejected.Rejected.GetMessage())
			c.status.failed("rejected", err, delay)
		case errors.Is(err, conn.ErrPinMismatch), errors.Is(err, errNotJoined), errors.Is(err, errOtherPanel):
			delay = rejectedRetry
			c.logger.Error("cannot connect to the panel", "err", err)
			c.status.failed("rejected", err, delay)
		default:
			if c.useStaged {
				// The panel went away during its move: its new address next.
				delay = reconnectMin
			}
			c.logger.Warn("panel connection ended", "err", err, "retry_in", delay.Round(time.Millisecond))
			c.status.failed("waiting", err, delay)
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
		}
	}
	return nil
}

// selfUpdater is the part of d.Updater that updates an agent the panel
// refused as too old (update.Service).
type selfUpdater interface {
	UpdateToLatest(ctx context.Context, minVersion string) error
}

// selfUpdate installs the latest release after an AGENT_TOO_OLD rejection:
// the panel cannot send UpdateAgent to an agent it does not accept. On
// success the agent restarts into the new binary.
func (c *connector) selfUpdate(ctx context.Context, minVersion string) {
	u, ok := c.deps.Updater.(selfUpdater)
	if !ok {
		c.logger.Error("the panel needs a newer agent and this build cannot update itself; reinstall it", "min_agent_version", minVersion)
		return
	}
	c.logger.Warn("the panel needs a newer agent; updating to the latest release", "min_agent_version", minVersion, "version", version.Version)
	if err := u.UpdateToLatest(ctx, minVersion); err != nil {
		c.logger.Error("self-update failed; update the agent with the installer", "err", err, "min_agent_version", minVersion)
		return
	}
	c.logger.Info("self-update installed; the agent restarts into it")
}

// backoff is exponential from reconnectMin to reconnectMax with jitter
// (half to full delay), so a fleet does not reconnect in lockstep after a
// panel restart.
func backoff(attempt int) time.Duration {
	d := reconnectMin << min(attempt-1, 16)
	if d > reconnectMax || d <= 0 {
		d = reconnectMax
	}
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

var errNotJoined = errors.New("this node has neither a node id nor a join token: join it again")

func (c *connector) connectOnce(ctx context.Context) error {
	cfg := c.config()
	target := primaryTarget(cfg)
	switch {
	case c.useStaged && cfg.Staged != nil && !c.stagedWaits(cfg):
		target = stagedTarget(cfg)
		c.logger.Warn("the panel's address does not answer; trying the address the panel staged for its move to another node",
			"panel_url", cfg.PanelURL, "staged", target.url, "move_id", cfg.StagedMove)
	case c.useFallback && cfg.Fallback != nil:
		target = fallbackTarget(cfg)
		c.logger.Warn("the panel's address does not answer; trying the previous one", "panel_url", cfg.PanelURL, "fallback", target.url)
	}
	c.useFallback, c.useStaged = false, false
	t, res, err := c.dial(ctx, target)
	if err != nil {
		var rejected *rpc.RejectedError
		if !target.fallback && !target.staged && !errors.As(err, &rejected) && ctx.Err() == nil {
			c.primaryFailed(cfg)
		}
		return err
	}
	promoted := false
	switch {
	case target.staged:
		// The panel moved: the staged address is the address from now on.
		c.promoteStaged(target)
		promoted = true
		c.primaryDown = time.Time{}
		target = primaryTarget(c.config())
	case !target.fallback:
		c.primaryDown = time.Time{}
		c.afterHandshake(cfg, res, t.ServerSPKI)
		target = primaryTarget(c.config()) // with the pin trust on first use just recorded
	}
	if next, ok := c.moveTarget(target, res.Accepted); ok {
		// The panel holds one session per node, so this one goes first.
		_ = t.Close("moving to the panel's new address")
		if t, res, err = c.move(ctx, target, next, res.Server.GetPanelId()); err != nil {
			return err
		}
		target = next
	} else if target.fallback {
		// Reached only through the fallback, and the panel names no other
		// address: the fallback is the address again.
		if restorable(cfg.Fallback) {
			c.restoreFallback()
		}
	} else if !promoted && cfg.Fallback != nil && !cfg.Fallback.Standing {
		c.endCycle()
	}
	return c.serve(ctx, t, res, target.url)
}

// primaryFailed decides whether the next attempt dials the fallback: at
// once during a move's first cycle, after standingFallbackAfter of failed
// connects for a standing fallback (then again every standingFallbackAfter).
// A staged address (the panel moving to another node) goes first once
// connects failed for stagedAfter: from then on every other attempt dials
// it, unless the moved panel on this node still waits for its switch.
func (c *connector) primaryFailed(cfg FileConfig) {
	now := time.Now()
	if c.primaryDown.IsZero() {
		c.primaryDown = now
	}
	if cfg.Staged != nil && now.Sub(c.primaryDown) >= stagedAfter && !c.stagedWaits(cfg) {
		c.useStaged = true
		return
	}
	f := cfg.Fallback
	switch {
	case f == nil:
	case !f.Standing:
		c.useFallback = true
	case now.Sub(c.primaryDown) >= standingFallbackAfter && now.Sub(c.standingTried) >= standingFallbackAfter:
		c.useFallback, c.standingTried = true, now
	}
}

// dial connects to target and runs the handshake.
func (c *connector) dial(ctx context.Context, target panelTarget) (*conn.WebSocket, *rpc.HandshakeResult, error) {
	url, err := AgentURL(target.url)
	if err != nil {
		return nil, nil, err
	}
	// Nodes without a public address are reached at the one they dial from.
	if ip := privateAddress(target.url); ip != "" {
		c.deps.Facts.Update(func(f *agentv1.NodeFacts) { f.PrivateIpv4 = ip })
	}
	if PlainRemote(target.url) {
		c.logger.Warn("the panel connection is plain HTTP: environment values, registry logins and shells cross the network unencrypted; "+
			"join again with the https:// command (and --pin) from the panel's Add node dialog", "panel_url", target.url)
	}
	opts := conn.DialOptions{URL: url, TrustOnFirstUse: target.tofu, RootCAs: c.rootCAs}
	if target.pin != "" {
		if opts.PinSHA256, err = conn.ParsePin(target.pin); err != nil {
			return nil, nil, err
		}
	}
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	t, err := conn.Dial(dialCtx, opts)
	cancel()
	if err != nil {
		return nil, nil, err
	}

	hsCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	res, err := rpc.AgentHandshake(hsCtx, t, func(server *agentv1.ServerHello) (*agentv1.ClientHello, error) {
		cfg := c.config()
		// Another panel gets no signature at all (panel_identity.go).
		if err := checkPanelID(cfg, target.url, server); err != nil {
			return nil, err
		}
		return c.hello(cfg, server)
	})
	cancel()
	if err != nil {
		_ = t.Close("handshake failed")
		var rejected *rpc.RejectedError
		if errors.As(err, &rejected) {
			if why := c.unprovenRejection(target, rejected); why != "" {
				return nil, nil, &unprovenRejectionError{url: target.url, rejected: rejected, why: why}
			}
		}
		return nil, nil, err
	}
	if err := c.checkPanelIdentity(target.url, res); err != nil {
		_ = t.Close("not this node's panel")
		return nil, nil, err
	}
	return t, res, nil
}

// serve runs an accepted session at address url until it ends.
func (c *connector) serve(ctx context.Context, t *conn.WebSocket, res *rpc.HandshakeResult, url string) error {
	c.cfgMu.Lock()
	c.sessionURL = url
	c.cfgMu.Unlock()
	defer func() {
		c.cfgMu.Lock()
		c.sessionURL = ""
		c.cfgMu.Unlock()
	}()
	session := rpc.NewSession(rpc.SessionConfig{
		Transport:        t,
		Role:             conn.RoleDialer,
		Handlers:         c.reg,
		PeerCapabilities: res.Server.GetCapabilities(),
		Logger:           c.logger,
		OnEvent: func(ev *agentv1.Event) {
			c.logger.Debug("ignoring event from the panel", "payload", fmt.Sprintf("%T", ev.GetPayload()))
		},
		OnClockOffset: func(offset time.Duration, lowerBound bool) {
			if c.clock != nil {
				go c.clock.observe(ctx, offset, lowerBound)
			}
		},
	})
	info := ConnInfo{
		NodeID:              res.Accepted.GetNodeId(),
		SessionID:           res.Accepted.GetSessionId(),
		PanelID:             res.Server.GetPanelId(),
		PanelVersion:        res.Server.GetPanelVersion(),
		PanelCapabilities:   slices.Clone(res.Server.GetCapabilities()),
		EdgeTicketPublicKey: slices.Clone(res.Accepted.GetEdgeTicketPublicKey()),
	}
	c.logger.Info("connected to the panel", "node_id", info.NodeID, "session_id", info.SessionID, "panel_version", info.PanelVersion)
	c.status.connected(info, session)

	sessCtx, cancelSession := context.WithCancel(ctx)
	c.link.Set(session)
	// Facts that changed between the hello and now (Docker answering for
	// the first time after install.sh started it) were emitted to no session.
	c.deps.Facts.Resend()
	c.deps.Components.connected(sessCtx, info)
	var wg sync.WaitGroup
	wg.Go(func() { c.drain(sessCtx, session) })
	wg.Go(func() { c.catchUpDesired(sessCtx, info) })
	wg.Go(func() { heartbeat(sessCtx, t, session) })
	wg.Go(func() { c.retryConfigSave(sessCtx) })

	err := session.Serve(ctx)
	c.link.Clear(session)
	cancelSession()
	wg.Wait()
	c.deps.Components.disconnected()
	c.status.disconnected(session)
	return err
}

// heartbeat pings the panel and closes the session when it stops
// answering, so the agent reconnects instead of waiting on a dead socket.
func heartbeat(ctx context.Context, p conn.Pinger, session *rpc.Session) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-ctx.Done():
			return
		}
		pctx, cancel := context.WithTimeout(ctx, pingTimeout)
		err := p.Ping(pctx)
		cancel()
		if err != nil && ctx.Err() == nil {
			session.Abort(fmt.Errorf("the panel stopped answering pings: %w", err))
			return
		}
	}
}

// hello builds the ClientHello: resume with the node key when the node
// joined, otherwise join with the token.
func (c *connector) hello(cfg FileConfig, server *agentv1.ServerHello) (*agentv1.ClientHello, error) {
	hello := &agentv1.ClientHello{AgentVersion: version.Version, Facts: c.deps.Facts.Get()}
	switch {
	case cfg.NodeID != "":
		hello.Credential = &agentv1.ClientHello_Resume{Resume: &agentv1.ResumeCredential{
			NodeId:    cfg.NodeID,
			Signature: rpc.SignHello(c.key, server, cfg.NodeID),
		}}
	case cfg.JoinToken != "":
		hello.Credential = &agentv1.ClientHello_Join{Join: &agentv1.JoinCredential{
			Token:         cfg.JoinToken,
			PublicKey:     c.key.Public().(ed25519.PublicKey),
			Signature:     rpc.SignHello(c.key, server, ""),
			RequestedName: cfg.NodeName,
		}}
	default:
		return nil, errNotJoined
	}
	return hello, nil
}

// afterHandshake records what the first accepted connection taught us:
// the node id after a join and the pin after trust-on-first-use. Memory is
// updated even when config.yml cannot be written: the panel has used up
// the join token by now, so the next connection must resume with the node
// key. The write is retried (retryConfigSave) until it lands.
func (c *connector) afterHandshake(used FileConfig, res *rpc.HandshakeResult, spki []byte) {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	next := *c.cfg
	changed := false
	if id := res.Accepted.GetNodeId(); id != "" && (next.NodeID != id || next.JoinToken != "") {
		next.NodeID, next.JoinToken = id, ""
		changed = true
	}
	if used.TrustOnFirstUse && next.PanelPin == "" && len(spki) > 0 {
		next.PanelPin, next.TrustOnFirstUse = conn.FormatPin(spki), false
		changed = true
		c.logger.Info("pinned the panel certificate on first use", "pin", next.PanelPin)
	}
	if !changed && !c.cfgUnsaved {
		return
	}
	if changed && used.NodeID == "" {
		c.logger.Info("joined the panel", "node_id", next.NodeID)
	}
	*c.cfg = next
	c.saveConfigLocked()
}

// saveConfigLocked writes the in-memory config; cfgMu must be held.
func (c *connector) saveConfigLocked() {
	if err := SaveConfig(c.cfgPath, c.cfg); err != nil {
		c.cfgUnsaved = true
		c.logger.Error("could not write config.yml; the node id and pin live only in memory until it works "+
			"(free disk space in the data dir), and a restart before then needs a new join token",
			"path", c.cfgPath, "node_id", c.cfg.NodeID, "err", err)
		return
	}
	if c.cfgUnsaved {
		c.logger.Info("config.yml written", "path", c.cfgPath)
	}
	c.cfgUnsaved = false
}

// retryConfigSave writes config.yml again while an earlier write failed.
func (c *connector) retryConfigSave(ctx context.Context) {
	for sleepCtx(ctx, configSaveRetry) {
		c.cfgMu.Lock()
		if c.cfgUnsaved {
			c.saveConfigLocked()
		}
		c.cfgMu.Unlock()
	}
}

// catchUpDesired asks the panel for the desired state when the agent has
// none (first start, or the stored file was unreadable). Normally the
// panel sends SyncDesired on its own right after the connect.
func (c *connector) catchUpDesired(ctx context.Context, info ConnInfo) {
	if c.desired.Revision() != 0 || !slices.Contains(info.PanelCapabilities, "panel.desired.v1") {
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, panelCallTimeout)
	resp, err := c.deps.Panel.GetDesiredState(callCtx, &agentv1.GetDesiredStateRequest{KnownRevision: 0})
	cancel()
	if err != nil {
		c.logger.Warn("fetching the desired state failed", "err", err)
		return
	}
	if resp.GetState() == nil {
		return
	}
	if _, _, err := c.desired.Sync(ctx, resp.GetState()); err != nil {
		c.logger.Error("saving the desired state from the panel failed", "err", err)
	}
}

// drain delivers outbox reports in order while the session lives. A report
// is removed only after the panel answered OK. Failures back off; a panel
// without panel.report.v1 is not retried until the next connection. Each
// delivery has panelCallTimeout; after drainTimeoutsToAbort timeouts in a
// row the session is aborted so the agent reconnects.
func (c *connector) drain(ctx context.Context, session aborter) {
	delay := reconnectMin
	timeouts := 0
	for ctx.Err() == nil {
		entries, err := c.outbox.Pending(ctx, 64)
		if err != nil {
			c.status.recordError("outbox", err)
			if !sleepCtx(ctx, delay) {
				return
			}
			continue
		}
		if len(entries) == 0 {
			select {
			case <-c.wake:
			case <-ctx.Done():
				return
			}
			continue
		}
		for _, e := range entries {
			err := c.deliver(ctx, e)
			if err == nil {
				if err := c.outbox.Ack(ctx, e.ID); err != nil {
					c.status.recordError("outbox", err)
				}
				delay, timeouts = reconnectMin, 0
				continue
			}
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, context.DeadlineExceeded) {
				if timeouts++; timeouts >= drainTimeoutsToAbort && session != nil {
					c.logger.Error("the panel stopped answering reports; reconnecting", "timeouts", timeouts)
					_ = session.Abort(fmt.Errorf("%d report deliveries in a row timed out after %s", timeouts, panelCallTimeout))
					return
				}
			} else {
				timeouts = 0
			}
			switch rpc.StatusOf(err).GetCode() {
			case agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT:
				// The panel will never take it; keeping it would block
				// every report behind it.
				c.logger.Error("the panel refused a report; dropping it", "outbox_id", e.ID, "err", err)
				_ = c.outbox.Ack(ctx, e.ID)
				continue
			case agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED:
				c.logger.Warn("the panel does not take reports yet; they stay queued until the next connection", "err", err)
				c.status.recordError("outbox", err)
				<-ctx.Done()
				return
			}
			c.logger.Warn("delivering a report failed", "outbox_id", e.ID, "err", err, "retry_in", delay)
			c.status.recordError("outbox", err)
			if !sleepCtx(ctx, delay) {
				return
			}
			delay = min(delay*2, drainRetryMax)
			break
		}
	}
}

// aborter is the part of rpc.Session the drain needs.
type aborter interface{ Abort(reason error) error }

func (c *connector) deliver(ctx context.Context, e state.OutboxEntry) error {
	ctx, cancel := context.WithTimeout(ctx, panelCallTimeout)
	defer cancel()
	if e.Crash != nil {
		_, err := c.deps.Panel.ReportCrash(ctx, &agentv1.ReportCrashRequest{OutboxId: e.ID, Report: e.Crash})
		return err
	}
	_, err := c.deps.Panel.ReportEvent(ctx, &agentv1.ReportEventRequest{OutboxId: e.ID, Event: e.Event})
	return err
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
