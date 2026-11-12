package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// Moving to the panel's new address. A node joins at
// the address its join command named, usually the panel's IP and agent TLS
// port. Once the panel has a domain with a working certificate it names it
// in every HelloAccepted (panel_url, panel_pin). The agent then closes that
// session, dials the new address and resumes there; config.yml changes
// only after a full handshake at the new address. The old address stays in
// config.yml as the fallback for one cycle: if the new address does not
// answer on the next connect, the agent tries the old one once, and a move
// that fails from there puts the old address back. After the cycle a
// pinned https:// fallback stays as a standing one, dialed once the new
// address failed for standingFallbackAfter, so a node whose panel domain
// was removed or changed finds the panel again; any other fallback is
// dropped. When panel_url fails on a certificate the node will never
// trust (inspectedCertificate) the fallback is dialed at once instead
// (connect.go primaryFailed). A failed move raises a PANEL_MOVE_FAILED
// node alert and is tried again after moveRetryAfter or an agent restart.
// The panel's own node dials loopback and never moves, and the panel
// names no address to a node whose Panel address is "stay"
// (ClientHello.stay_on_address).
//
// A node at a pinned https:// address whose move fails because the new
// address's certificate comes from an issuer it does not trust, or does
// not match the pin the panel sent (inspectedCertificate), waits
// untrustedMoveRetryAfter instead: most often its network decrypts HTTPS
// (TLS inspection re-signs the domain's certificate), which is why it
// joined over the panel's IP and pin, and the panel names its domain on
// every connect. Each try drops the session the panel just accepted, so
// the node tries that address again only after that long, or when the
// panel names another address or a pin for it. Since 0.2.14 that wait
// (from any address) is kept in state/panel.json, so restarts and updates
// do not try it again either, and it goes once the panel stops naming the
// address (panel_memory.go); `seylo set-panel` moves the node by hand. A
// certificate that is expired, not valid yet or for another name is no
// sign of that (a clock that is not set yet, DNS that still leads to the
// old server) and keeps moveRetryAfter, in memory only.
//
// Only an authenticated session (https:// with a pin or a CA-verified
// certificate) can move the node. Over plain HTTP anyone on the path can
// write the ServerHello and the HelloAccepted, panel id included, so such a
// session never names the node's address: it would let one injected hello
// hand the node to another panel for good. Nodes that joined over plain
// HTTP move by joining again with the https:// command (seylo join
// --force). For the same reason a plain http:// fallback (a config written
// by hand) is never written back as panel_url, and the panel naming the
// address in use without a pin never drops the pin the node has.

// Variables so tests can change them.
var (
	// moveRetryAfter is how long a failed move to an address waits before
	// the agent tries it again.
	moveRetryAfter = time.Hour
	// untrustedMoveRetryAfter is that wait for a node at a pinned https://
	// address whose move failed on the new address's certificate's issuer
	// or pin (inspectedCertificate).
	untrustedMoveRetryAfter = 24 * time.Hour
	// standingFallbackAfter is how long connects to panel_url fail before
	// the agent dials a standing fallback.
	standingFallbackAfter = 5 * time.Minute
	// moveAttempts and moveAttemptDelay ride out the panel still holding
	// the session the agent just closed (ALREADY_CONNECTED).
	moveAttempts     = 5
	moveAttemptDelay = time.Second
	// ownNodePanel reports whether the agent dials its own machine.
	ownNodePanel = loopbackURL
	// panelRoots verifies panels without a pin; nil means the system roots.
	panelRoots *x509.CertPool
)

// errMoveFailed wraps why a move to the panel's new address failed. The
// agent reconnects to the old address right away.
var errMoveFailed = errors.New("moving to the panel's new address failed")

// panelTarget is one address the agent can dial.
type panelTarget struct {
	url string
	// pin is "sha256:<hex>"; empty verifies with the CA roots.
	pin      string
	insecure bool
	tofu     bool
	// fallback marks config.yml's fallback address.
	fallback bool
	// staged marks config.yml's staged address (panel_stage.go).
	staged bool
}

func primaryTarget(cfg FileConfig) panelTarget {
	return panelTarget{url: cfg.PanelURL, pin: cfg.PanelPin, insecure: cfg.InsecureTransport, tofu: cfg.TrustOnFirstUse && cfg.PanelPin == ""}
}

func fallbackTarget(cfg FileConfig) panelTarget {
	f := cfg.Fallback
	return panelTarget{url: f.PanelURL, pin: f.PanelPin, insecure: f.InsecureTransport, fallback: true}
}

// moveTarget returns where HelloAccepted asks the agent to move, or false
// to stay: no address named, the agent dials its own machine, the session
// is plain HTTP (logged once), the address is the one in use (with the
// node's pin, or without one when the node has none), a failed move to it
// waits for its retry, or it is not usable (logged).
func (c *connector) moveTarget(current panelTarget, acc *agentv1.HelloAccepted) (panelTarget, bool) {
	raw := strings.TrimSpace(acc.GetPanelUrl())
	if raw == "" || ownNodePanel(current.url) {
		return panelTarget{}, false
	}
	if !tlsURL(current.url) {
		if !c.plainMoveWarned {
			c.plainMoveWarned = true
			c.logger.Warn("ignoring panel_url from a plain-HTTP session (anyone on the network path could have sent it); "+
				"join again with the https:// command from the panel's Add node dialog (seylo join --force)",
				"panel_url", raw, "current", current.url)
		}
		return panelTarget{}, false
	}
	next, err := parseMoveTarget(raw, acc.GetPanelPin())
	if err != nil {
		c.logger.Warn("ignoring the panel's new address", "panel_url", raw, "err", err)
		return panelTarget{}, false
	}
	if sameTarget(current, next) || dropsPin(current, next) {
		return panelTarget{}, false
	}
	if w, ok := c.moveRetry[moveKey(next)]; ok && time.Now().Before(w.until) {
		return panelTarget{}, false
	}
	return next, true
}

// parseMoveTarget checks the address HelloAccepted names: https:// only
// (the agent never moves to plain HTTP), and a pin that parses.
func parseMoveTarget(raw, pin string) (panelTarget, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return panelTarget{}, fmt.Errorf("%q is not a URL", raw)
	}
	if u.Scheme != "https" && u.Scheme != "wss" {
		return panelTarget{}, fmt.Errorf("%q is not https://", raw)
	}
	t := panelTarget{url: raw}
	if pin = strings.TrimSpace(pin); pin != "" {
		b, err := conn.ParsePin(pin)
		if err != nil {
			return panelTarget{}, fmt.Errorf("panel_pin: %w", err)
		}
		t.pin = conn.FormatPin(b)
	}
	return t, nil
}

// sameTarget compares addresses by their agent URL (scheme, lower-case
// host, default port dropped) and pin.
func sameTarget(a, b panelTarget) bool {
	return canonicalAgentURL(a.url) == canonicalAgentURL(b.url) && canonicalPin(a.pin) == canonicalPin(b.pin)
}

// dropsPin reports whether next is the address in use without the pin
// the node has (one its owner chose, or trust on first use recorded): the
// panel names its address without a pin, and that is never a reason to
// trust less. A different pin, or a pin where there was none, still moves.
func dropsPin(current, next panelTarget) bool {
	return current.pin != "" && next.pin == "" && canonicalAgentURL(current.url) == canonicalAgentURL(next.url)
}

func canonicalAgentURL(raw string) string {
	s, err := AgentURL(raw)
	if err != nil {
		return raw
	}
	u, err := url.Parse(s)
	if err != nil {
		return s
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	if (u.Scheme == "wss" && port == "443") || (u.Scheme == "ws" && port == "80") {
		port = ""
	}
	switch {
	case port != "":
		u.Host = net.JoinHostPort(host, port)
	case strings.Contains(host, ":"):
		u.Host = "[" + host + "]"
	default:
		u.Host = host
	}
	return u.String()
}

func canonicalPin(pin string) string {
	if b, err := conn.ParsePin(pin); err == nil {
		return conn.FormatPin(b)
	}
	return pin
}

func moveKey(t panelTarget) string { return canonicalAgentURL(t.url) + " " + canonicalPin(t.pin) }

// move dials to after the session at from was closed. On success the new
// address is in config.yml with from as its fallback; on failure the old
// address stays (or comes back, when from was the fallback) and the move
// waits for moveRetryAfter.
func (c *connector) move(ctx context.Context, from, to panelTarget, panelID string) (*conn.WebSocket, *rpc.HandshakeResult, error) {
	c.logger.Info("the panel names a new address for this node; moving", "from", from.url, "to", to.url)
	var err error
	for attempt := 1; ; attempt++ {
		var t *conn.WebSocket
		var res *rpc.HandshakeResult
		t, res, err = c.dial(ctx, to)
		if err == nil && res.Server.GetPanelId() != panelID {
			_ = t.Close("another panel")
			err = fmt.Errorf("%s answers as another panel (%q, not %q)", to.url, res.Server.GetPanelId(), panelID)
		}
		if err == nil {
			c.moved(ctx, from, to)
			c.accepted(to, res.Accepted)
			return t, res, nil
		}
		var rejected *rpc.RejectedError
		busy := errors.As(err, &rejected) && rejected.Rejected.GetReason() == agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED
		if !busy || attempt >= moveAttempts || !sleepCtx(ctx, moveAttemptDelay) {
			break
		}
	}
	if ctx.Err() == nil {
		c.moveFailed(ctx, from, to, err)
	}
	return nil, nil, fmt.Errorf("%w: %w", errMoveFailed, err)
}

// movedConfig is cfg after a move from one address to another (moved, and
// `seylo set-panel`, set_panel.go): to becomes panel_url and panel_pin,
// from the fallback for one cycle, insecure_transport and
// trust_on_first_use go. Everything else stays (node_id, the panel's
// identity, staged).
func movedConfig(cfg FileConfig, from, to panelTarget) FileConfig {
	next := cfg
	fallback := &PanelAddress{PanelURL: from.url, PanelPin: from.pin, InsecureTransport: from.insecure}
	if old := next.Fallback; !standingCandidate(fallback) && standingCandidate(old) {
		// Moving from one domain to the next: the pinned address the node
		// had before is the better fallback to keep.
		kept := *old
		kept.Standing = false
		fallback = &kept
	}
	next.Fallback = fallback
	next.PanelURL, next.PanelPin = to.url, to.pin
	next.InsecureTransport, next.TrustOnFirstUse = false, false
	return next
}

// moved records a successful move in config.yml.
func (c *connector) moved(ctx context.Context, from, to panelTarget) {
	c.cfgMu.Lock()
	next := movedConfig(*c.cfg, from, to)
	*c.cfg = next
	c.saveConfigLocked()
	c.cfgMu.Unlock()
	kept := false
	for _, w := range c.moveRetry {
		kept = kept || w.kept
	}
	clear(c.moveRetry)
	if kept {
		c.saveMemory()
	}
	c.moveAlerted = ""
	c.logger.Info("moved to the panel's new address; the old one stays as a fallback until a reconnect there works",
		"panel_url", to.url, "fallback", next.Fallback.PanelURL)
	// An alert raised before a restart is not remembered, so every move
	// resolves; the panel ignores a resolve without an open alert.
	c.moveAlert(ctx, &agentv1.NodeAlert{
		Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_PANEL_MOVE_FAILED,
		Severity: agentv1.AlertSeverity_ALERT_SEVERITY_INFO,
		Message:  "The node connects through " + to.url + " now",
		Resolved: true,
	})
}

// moveFailed keeps (or puts back) the old address and reports why, once
// per address (moveAlerted). A move from a pinned https:// address that
// failed on the certificate's issuer or pin (inspectedCertificate) waits
// untrustedMoveRetryAfter, any other moveRetryAfter. A move that failed on
// the issuer or the pin is kept in state/panel.json (panel_memory.go): an
// agent restart or update does not try it again, so it does not drop the
// first session the panel accepts and raise the alert once more.
func (c *connector) moveFailed(ctx context.Context, from, to panelTarget, err error) {
	key := moveKey(to)
	untrusted := untrustedCertificate(err)
	inspected := inspectedCertificate(err)
	pinned := inspected && from.pin != "" && tlsURL(from.url)
	retry := moveRetryAfter
	if pinned {
		retry = untrustedMoveRetryAfter
	}
	if c.moveRetry == nil {
		c.moveRetry = map[string]moveWait{}
	}
	c.moveRetry[key] = moveWait{target: to, until: time.Now().Add(retry), kept: inspected}
	if inspected {
		c.saveMemory()
	}
	stay := from.url
	if from.fallback && restorable(c.config().Fallback) {
		c.restoreFallback()
	}
	c.logger.Error("could not move to the panel's new address; staying on the current one",
		"panel_url", to.url, "current", stay, "retry_in", retry, "err", err)
	if c.moveAlerted == key {
		return
	}
	c.moveAlerted = key
	// The error is one line: it can quote what the new address chose (its
	// certificate's names), and the owner reads it in the panel.
	again := "or when the agent restarts"
	if inspected {
		again = "or when the panel names another address"
	}
	msg := fmt.Sprintf("Could not move to the panel address %s: %s\nThe node keeps connecting through %s and tries again in %s %s.",
		to.url, conn.PrintableLine(err.Error()), stay, durationWords(retry), again)
	switch {
	case inspected:
		msg += fmt.Sprintf(" The node does not trust that address's certificate: the panel must send its pin, or the certificate must come from a CA in the node's trust store (then `%s set-panel %s` on the node moves it).", brand.Slug, to.url)
	case untrusted:
		msg += " The node does not trust that address's certificate: the panel must send its pin, or the certificate must come from a CA in the node's trust store (an agent restart reloads it)."
	}
	if pinned {
		msg += " If the node's network decrypts HTTPS (TLS inspection), it cannot use that address and stays on its pinned one: the panel keeps it there (Panel address in the node's settings) until you choose otherwise."
	}
	c.moveAlert(ctx, &agentv1.NodeAlert{
		Kind:                 agentv1.NodeAlertKind_NODE_ALERT_KIND_PANEL_MOVE_FAILED,
		Severity:             agentv1.AlertSeverity_ALERT_SEVERITY_WARNING,
		Message:              msg,
		InspectedCertificate: pinned,
	})
}

func untrustedCertificate(err error) bool {
	var unknown x509.UnknownAuthorityError
	var verify *tls.CertificateVerificationError
	var hostname x509.HostnameError
	return errors.As(err, &unknown) || errors.As(err, &verify) || errors.As(err, &hostname) || errors.Is(err, conn.ErrPinMismatch)
}

// inspectedCertificate reports whether err is what TLS inspection makes of
// a certificate: one from an issuer the node does not trust, or one whose
// key is not the pinned one. An expired or not yet valid certificate, or
// one for another name, is not.
func inspectedCertificate(err error) bool {
	var unknown x509.UnknownAuthorityError
	return errors.As(err, &unknown) || errors.Is(err, conn.ErrPinMismatch)
}

func (c *connector) moveAlert(ctx context.Context, alert *agentv1.NodeAlert) {
	if c.deps.Reports == nil {
		return
	}
	ev := &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: alert}}
	if err := c.deps.Reports.Event(context.WithoutCancel(ctx), ev); err != nil {
		c.logger.Error("queueing the panel move alert", "err", err)
	}
}

// restoreFallback makes the fallback address panel_url again: the node
// reached the panel only there.
func (c *connector) restoreFallback() {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	f := c.cfg.Fallback
	if f == nil {
		return
	}
	next := *c.cfg
	c.logger.Warn("the panel is reachable only through the previous address; making it panel_url again",
		"panel_url", f.PanelURL, "was", next.PanelURL)
	next.PanelURL, next.PanelPin, next.InsecureTransport = f.PanelURL, f.PanelPin, f.InsecureTransport
	next.TrustOnFirstUse, next.Fallback = false, nil
	*c.cfg = next
	c.saveConfigLocked()
}

// endCycle runs once panel_url worked on a new connection after the move:
// a pinned https:// fallback becomes a standing one, any other is dropped.
func (c *connector) endCycle() {
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	f := c.cfg.Fallback
	if f == nil || f.Standing {
		return
	}
	next := *c.cfg
	if standingCandidate(f) {
		kept := *f
		kept.Standing = true
		next.Fallback = &kept
		c.logger.Info("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering",
			"panel_url", next.PanelURL, "fallback", f.PanelURL)
	} else {
		next.Fallback = nil
		c.logger.Info("the panel's new address works after a reconnect; forgetting the previous one", "panel_url", next.PanelURL, "previous", f.PanelURL)
	}
	*c.cfg = next
	c.saveConfigLocked()
}

// restorable reports whether a fallback may become panel_url again: only
// https://, since a plain HTTP session proves nothing about the panel.
func restorable(f *PanelAddress) bool {
	return f != nil && tlsURL(f.PanelURL)
}

// tlsURL reports whether raw is dialed over TLS (https:// or wss://).
func tlsURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (u.Scheme == "https" || u.Scheme == "wss")
}

// standingCandidate reports whether a fallback may stay after the cycle:
// https:// with a pin, which nobody who blocks the domain can impersonate.
func standingCandidate(f *PanelAddress) bool {
	return restorable(f) && f.PanelPin != ""
}

// durationWords is d for a sentence: "an hour", "5 minutes".
func durationWords(d time.Duration) string {
	switch {
	case d == time.Hour:
		return "an hour"
	case d >= time.Hour && d%time.Hour == 0:
		return fmt.Sprintf("%d hours", d/time.Hour)
	case d >= time.Minute && d%time.Minute == 0:
		return fmt.Sprintf("%d minutes", d/time.Minute)
	}
	return d.String()
}
