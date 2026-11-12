package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/state"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/version"
)

// Pointing a joined node at another address of its panel (`seylo
// set-panel <url> [--pin sha256:<hex>]`). A node that joined over the
// panel's domain stops connecting once its network starts decrypting HTTPS
// (TLS inspection re-signs the domain's certificate, and the agent refuses
// it). Joining again needs a new join token and forgets the panel identity
// the node recorded; set-panel needs neither: it keeps config.yml and
// points the node at the panel's IP address and agents' TLS port with the
// pin.
//
// Nothing is written before the new address proved to be the panel this
// node belongs to, checked the way the agent checks every connect: it is
// dialed with the pin (or the system roots), the node resumes there with
// its own key, and the panel identity in config.yml (panel_id, panel_key,
// panel_proves, panel_identity.go) must match. A refusal counts only when
// it is signed with the recorded key (or the node has nothing to check it
// against): ALREADY_CONNECTED (the agent is connected through the old
// address right now), AGENT_TOO_OLD (the agent updates itself once it
// connects) and NODE_DISABLED still change the address, any other refusal
// does not. The accepted session is closed at once. Then config.yml
// changes as a move does (movedConfig): the new address becomes
// panel_url/panel_pin, the old one the fallback for one cycle; node_id,
// the identity and a staged address stay. The file as it was is kept as
// config.yml.bak.

// SetPanelOptions are `seylo set-panel`'s arguments.
type SetPanelOptions struct {
	// PanelURL is the panel's other address, usually
	// https://<panel IP>:<agents' TLS port>.
	PanelURL string
	// Pin is "sha256:<hex>" of the panel's agents' TLS key; empty verifies
	// the certificate with the system roots.
	Pin string
	// Insecure accepts a plain http:// URL on another host, like `join
	// --insecure`.
	Insecure bool
	// RootCAs verifies the panel without a pin; nil means the system roots.
	RootCAs *x509.CertPool
}

// SetPanelResult is what SetPanel found and did.
type SetPanelResult struct {
	// Previous is the panel_url the node had.
	Previous string
	// PanelURL and PanelPin are what config.yml says now.
	PanelURL, PanelPin string
	// PanelID and PanelVersion are what the new address answered with.
	PanelID, PanelVersion string
	// Refused is the refusal the panel answered with, when it was one that
	// still changes the address (ALREADY_CONNECTED, AGENT_TOO_OLD,
	// NODE_DISABLED); nil when it accepted the node.
	Refused *agentv1.HelloRejected
	// Unchanged: config.yml already pointed there; nothing was dialed or written.
	Unchanged bool
	// Backup is the copy of config.yml as it was.
	Backup string
}

// SetPanel checks that opts.PanelURL is this node's panel and points
// config.yml at it. It does not restart the agent. On any error config.yml
// is as it was.
func SetPanel(ctx context.Context, layout datadir.Layout, opts SetPanelOptions) (*SetPanelResult, error) {
	path := layout.ConfigFile()
	cfg, err := LoadConfig(path)
	if err != nil {
		return nil, err
	}
	if cfg.NodeID == "" {
		return nil, fmt.Errorf("this node has not finished joining its panel (config.yml has no node_id): run the join command again with the new address and --force")
	}
	to, err := setPanelTarget(opts)
	if err != nil {
		return nil, err
	}
	from := primaryTarget(*cfg)
	res := &SetPanelResult{Previous: cfg.PanelURL, PanelURL: to.url, PanelPin: to.pin}
	if sameTarget(from, to) && from.insecure == to.insecure {
		res.Unchanged = true
		return res, nil
	}
	key, err := readAgentKey(layout.AgentKey())
	if err != nil {
		return nil, err
	}
	if err := checkSamePanel(ctx, *cfg, key, to, opts.RootCAs, res); err != nil {
		if errors.Is(err, errOtherPanel) {
			err = fmt.Errorf("%w. To move this node to another panel, join it there with a join command from that panel's Add node dialog", err)
		}
		return nil, err
	}

	old, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	res.Backup = path + ".bak"
	if err := state.WriteFileAtomic(res.Backup, old, 0o600); err != nil {
		return nil, fmt.Errorf("writing the backup %s: %w", res.Backup, err)
	}
	next := movedConfig(*cfg, from, to)
	next.InsecureTransport = to.insecure
	if err := next.Validate(); err != nil {
		return nil, err
	}
	if err := SaveConfig(path, &next); err != nil {
		return nil, err
	}
	return res, nil
}

// setPanelTarget checks the address and pin set-panel was given.
func setPanelTarget(opts SetPanelOptions) (panelTarget, error) {
	raw := strings.TrimSpace(opts.PanelURL)
	if _, err := AgentURL(raw); err != nil {
		return panelTarget{}, err
	}
	t := panelTarget{url: raw}
	if pin := strings.TrimSpace(opts.Pin); pin != "" {
		if !tlsURL(raw) {
			return panelTarget{}, fmt.Errorf("--pin needs an https:// panel URL, and %s is not one", raw)
		}
		b, err := conn.ParsePin(pin)
		if err != nil {
			return panelTarget{}, fmt.Errorf("--pin: %w", err)
		}
		t.pin = conn.FormatPin(b)
	}
	if PlainRemote(raw) {
		if !opts.Insecure {
			return panelTarget{}, fmt.Errorf("%w: %s would carry the agent protocol (environment values, registry logins, shells) unencrypted. "+
				"Use the https:// address with --pin from the panel's Add node dialog, or pass --insecure to use plain HTTP anyway", ErrPlainTransport, raw)
		}
		t.insecure = true
	}
	return t, nil
}

// readAgentKey reads the node's key without making one: a node without it
// cannot resume as itself.
func readAgentKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("no agent key at %s: this node cannot resume without it, so join it again", path)
	}
	if err != nil {
		return nil, fmt.Errorf("reading the agent key: %w", err)
	}
	return parseKey(b)
}

// checkSamePanel dials to, resumes as this node and checks the panel's
// identity the way connector.dial does, then closes the session.
func checkSamePanel(ctx context.Context, cfg FileConfig, key ed25519.PrivateKey, to panelTarget, roots *x509.CertPool, res *SetPanelResult) error {
	wsURL, err := AgentURL(to.url)
	if err != nil {
		return err
	}
	opts := conn.DialOptions{URL: wsURL, RootCAs: roots}
	if to.pin != "" {
		if opts.PinSHA256, err = conn.ParsePin(to.pin); err != nil {
			return err
		}
	}
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	t, err := conn.Dial(dialCtx, opts)
	cancel()
	if errors.Is(err, conn.ErrPinMismatch) {
		return fmt.Errorf("%s did not present the key --pin names (copy the pin from the panel's Add node dialog): %w", to.url, err)
	}
	if err != nil {
		return fmt.Errorf("could not connect to %s: %w", to.url, err)
	}
	defer func() { _ = t.Close(brand.Slug + " set-panel checked this address") }()

	hsCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()
	hs, err := rpc.AgentHandshake(hsCtx, t, func(server *agentv1.ServerHello) (*agentv1.ClientHello, error) {
		// Another panel gets no signature at all, as on every connect.
		if err := checkPanelID(cfg, to.url, server); err != nil {
			return nil, err
		}
		res.PanelID, res.PanelVersion = server.GetPanelId(), server.GetPanelVersion()
		// No facts: this process has only the machine part of them (the
		// runtime, network and build components fill the rest, capabilities
		// included), and partial facts would replace the node's. A panel
		// since 0.2.12 leaves the stored facts and public addresses alone
		// for a hello without facts (decideHello in agent-hub/handshake.ts)
		// until the agent itself connects after the restart.
		return &agentv1.ClientHello{AgentVersion: version.Version, Credential: &agentv1.ClientHello_Resume{Resume: &agentv1.ResumeCredential{
			NodeId:    cfg.NodeID,
			Signature: rpc.SignHello(key, server, cfg.NodeID),
		}}}, nil
	})
	var rejected *rpc.RejectedError
	switch {
	case errors.As(err, &rejected):
		return provenRefusal(cfg, to.url, rejected, res)
	case errors.Is(err, errOtherPanel):
		return err
	case err != nil:
		return fmt.Errorf("checking %s: %w", to.url, err)
	}
	if err := verifyPanelIdentity(cfg, to.url, hs); err != nil {
		return err
	}
	if id := hs.Accepted.GetNodeId(); id != cfg.NodeID {
		return fmt.Errorf("%s accepted this node as %q, not as %q: %w", to.url, id, cfg.NodeID, errOtherPanel)
	}
	return nil
}

// provenRefusal decides about a panel that refused the resume: nil (go on)
// when the refusal is signed by this node's panel and still means the
// address is right, an error otherwise.
func provenRefusal(cfg FileConfig, url string, rej *rpc.RejectedError, res *SetPanelResult) error {
	reason := rej.Rejected.GetReason()
	if why := unsignedRejection(cfg, rej); why != "" {
		err := fmt.Errorf("%s refused this node (%s), but %s: it is not proven to be the panel this node belongs to", url, reason, why)
		if reason == agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED {
			err = fmt.Errorf("%w. It says the agent is connected right now: stop it (sudo systemctl stop %s) and run the command again", err, systemd.AgentUnit)
		}
		return err
	}
	switch reason {
	case agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED,
		agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD,
		agentv1.HelloRejectReason_HELLO_REJECT_REASON_NODE_DISABLED:
		res.Refused = rej.Rejected
		return nil
	}
	return fmt.Errorf("%s refused this node: %s (%s)", url, conn.PrintableLine(rej.Rejected.GetMessage()), reason)
}
