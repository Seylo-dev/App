package agent

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// The panel's identity. A node trusts its panel's address through a pin
// (the agents' TLS port) or, once it moved to the panel's domain, through
// the public CA alone: whoever gets a certificate for that name (a lapsed
// domain, a hijacked DNS record or registrar, an HTTP-01 challenge passed
// by taking over the panel's IP for a moment) could answer as the panel
// and take every node that moved, with root on them. So the node also
// remembers which panel it belongs to and checks it on every connect,
// whatever the address and its certificate:
//
//   - panel_id (ServerHello) is recorded at the first accepted handshake;
//     another one is refused before the ClientHello, so nothing is signed
//     for it;
//   - the panel's identity key, its Ed25519 edge ticket key
//     (HelloAccepted.edge_ticket_public_key), is recorded with it; a
//     session naming another key is closed before any call is served;
//   - HelloAccepted.panel_signature proves the panel holds that key's
//     private half, over this connection's nonce and the node's own
//     signature. Once a node saw one, every HelloAccepted must carry one.
//
// panel_id and the public key are not secret, so until the panel signs
// its HelloAccepted they only stop an impostor who never talked to the
// real panel; the signature makes the key matter. Neither binds the TLS
// connection, so someone relaying a whole session to the real panel is
// not detected by this; the pinned standing fallback (move.go) is what
// keeps such a node reachable for its real panel.

// errOtherPanel: the address answered as a panel other than the one this
// node belongs to.
var errOtherPanel = errors.New("not the panel this node belongs to")

// decodePanelKey parses config.yml's panel_key.
func decodePanelKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not a base64 Ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// checkPanelID runs on the ServerHello, before the agent signs anything.
func checkPanelID(cfg FileConfig, url string, server *agentv1.ServerHello) error {
	if cfg.PanelID == "" || server.GetPanelId() == cfg.PanelID {
		return nil
	}
	return fmt.Errorf("%s answers as another panel (%q, this node belongs to %q): %w", url, server.GetPanelId(), cfg.PanelID, errOtherPanel)
}

// checkPanelIdentity runs on an accepted handshake, before the session is
// used: the identity key must be the recorded one and, when the node knows
// its panel signs, proven. On the first accepted handshake it records the
// panel id and key (and that the panel signs).
func (c *connector) checkPanelIdentity(url string, res *rpc.HandshakeResult) error {
	key := res.Accepted.GetEdgeTicketPublicKey()
	sig := res.Accepted.GetPanelSignature()
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	cfg := *c.cfg
	if cfg.PanelKey != "" {
		known, _ := decodePanelKey(cfg.PanelKey) // Validate checked it
		if !bytes.Equal(known, key) {
			return fmt.Errorf("%s answers with another panel identity key: %w", url, errOtherPanel)
		}
	}
	switch {
	case len(sig) > 0:
		if !rpc.VerifyPanelAccept(ed25519.PublicKey(key), res.Server, res.Client, res.Accepted) {
			return fmt.Errorf("%s: the panel's signature does not match its identity key: %w", url, errOtherPanel)
		}
	case cfg.PanelProves:
		return fmt.Errorf("%s did not prove the panel's identity (no panel_signature, which this panel sent before): %w", url, errOtherPanel)
	}

	next := cfg
	if next.PanelID == "" && res.Server.GetPanelId() != "" {
		next.PanelID = res.Server.GetPanelId()
	}
	if next.PanelKey == "" && len(key) == ed25519.PublicKeySize {
		next.PanelKey = base64.StdEncoding.EncodeToString(key)
	}
	if len(sig) > 0 {
		next.PanelProves = true
	}
	if next.PanelID == cfg.PanelID && next.PanelKey == cfg.PanelKey && next.PanelProves == cfg.PanelProves {
		return nil
	}
	c.logger.Info("recorded the panel's identity; other panels are refused from now on",
		"panel_id", next.PanelID, "signed", next.PanelProves)
	*c.cfg = next
	c.saveConfigLocked()
	return nil
}
