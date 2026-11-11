package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/update"
)

// Moving the panel to another node, the connection side (panel.relocate.v1).
// Before the old panel goes away it stages its next address on every
// node (StagePanelAddress): https://<target>:<agents' TLS port> with the
// pin of the agents' TLS key, which moves with the panel, and
// https://127.0.0.1:<port> on the target itself. The address is checked
// first by a TLS dial with the pin. It is kept apart from the fallback and
// survives reconnects to the old panel. Once panel_url stops answering
// (the connections fail; a refusal does not count) for stagedAfter, the
// agent dials the staged address, and the usual checks apply there (the
// panel id before anything is signed, the identity key after). Once a
// session there is accepted, it is panel_url: the old address and the
// fallback are forgotten, since the old panel was retired and must never
// get a node back. The panel's own node, which dials loopback over plain
// HTTP and never moves otherwise, leaves it this way too. A move that is
// aborted clears the address again (ClearPanelAddress).
//
// Only an authenticated session may stage an address, or carry a step that
// ships the panel's keys or switches to the moved panel: a remote
// plain-HTTP session is refused for the same reason it never moves the
// node (move.go). Loopback is fine (the panel's own node).

// Variables so tests can change them.
var (
	// stagedAfter is how long connects to panel_url fail before the agent
	// dials the staged address. A blip in the seconds the old panel stages
	// and retires does not send a node to the moved panel before the switch.
	stagedAfter = 10 * time.Second
	// stageProbeTimeout bounds StagePanelAddress's probe.
	stageProbeTimeout = 10 * time.Second
)

// Status details reasons of StagePanelAddress, next to update's.
const (
	reasonPlainHTTP = "plainHttp"
	reasonProbe     = "probe"
	reasonConfig    = "config"
)

func stagedTarget(cfg FileConfig) panelTarget {
	st := cfg.Staged
	return panelTarget{url: st.PanelURL, pin: st.PanelPin, staged: true}
}

// promoteStaged makes the staged address panel_url: a session there was
// accepted, so the panel moved.
func (c *connector) promoteStaged(to panelTarget) {
	c.cfgMu.Lock()
	next := *c.cfg
	move, was := next.StagedMove, next.PanelURL
	next.PanelURL, next.PanelPin = to.url, to.pin
	next.InsecureTransport, next.TrustOnFirstUse = false, false
	next.Staged, next.StagedMove, next.Fallback = nil, "", nil
	*c.cfg = next
	c.saveConfigLocked()
	c.cfgMu.Unlock()
	clear(c.moveRetry)
	c.moveAlerted = ""
	c.logger.Info("the panel moved to another node; this node connects there from now on", "panel_url", to.url, "was", was, "move_id", move)
	if a, ok := c.deps.Updater.(panelArrival); ok && move != "" {
		a.PanelArrived(move)
	}
}

// panelArrival is the part of update.Service that ends a move on the node
// the panel moved to.
type panelArrival interface{ PanelArrived(moveID string) }

// stageError is a refusal with a reason in the status details.
func stageError(code agentv1.StatusCode, reason, msg string) error {
	e := rpc.NewError(code, msg)
	e.Details = map[string]string{"reason": reason}
	return e
}

// StagePanelAddress records the address this node switches to when its
// panel goes away (PanelStager).
func (c *connector) StagePanelAddress(ctx context.Context, req *agentv1.StagePanelAddressRequest) (*agentv1.StagePanelAddressResponse, error) {
	if !update.ValidMoveID(req.GetMoveId()) {
		return nil, stageError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, update.ReasonBadRequest, fmt.Sprintf("move_id %q is not a move id", req.GetMoveId()))
	}
	if err := c.CheckPrivateSession("anyone on the path could stage an address"); err != nil {
		return nil, err
	}
	target, err := parseStagedTarget(req.GetPanelUrl(), req.GetPanelPin())
	if err != nil {
		return nil, stageError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, update.ReasonBadRequest, err.Error())
	}
	var took time.Duration
	if req.GetProbe() {
		started := time.Now()
		if err := probePanel(ctx, target); err != nil {
			msg := fmt.Sprintf("this node cannot reach the panel's new address %s: %v", target.url, err)
			if errors.Is(err, conn.ErrPinMismatch) {
				msg = fmt.Sprintf("%s answers with another key than the panel's agents' TLS key", target.url)
			}
			return nil, stageError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, reasonProbe, msg)
		}
		took = time.Since(started)
	}
	c.cfgMu.Lock()
	next := *c.cfg
	next.Staged = &PanelAddress{PanelURL: target.url, PanelPin: target.pin}
	next.StagedMove = req.GetMoveId()
	if err := SaveConfig(c.cfgPath, &next); err != nil {
		c.cfgMu.Unlock()
		return nil, stageError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, reasonConfig, "could not write config.yml: "+err.Error())
	}
	*c.cfg = next
	c.cfgUnsaved = false
	c.cfgMu.Unlock()
	c.logger.Info("the panel staged its next address for its move to another node", "move_id", req.GetMoveId(), "staged", target.url)
	return &agentv1.StagePanelAddressResponse{ProbeMillis: uint32(took.Milliseconds())}, nil
}

// ClearPanelAddress drops the staged address of that move (PanelStager);
// one another move staged stays.
func (c *connector) ClearPanelAddress(_ context.Context, req *agentv1.ClearPanelAddressRequest) error {
	if !update.ValidMoveID(req.GetMoveId()) {
		return stageError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, update.ReasonBadRequest, fmt.Sprintf("move_id %q is not a move id", req.GetMoveId()))
	}
	c.cfgMu.Lock()
	defer c.cfgMu.Unlock()
	if c.cfg.StagedMove != req.GetMoveId() {
		return nil
	}
	next := *c.cfg
	next.Staged, next.StagedMove = nil, ""
	*c.cfg = next
	// Gone from memory at once; a failed write is tried again (retryConfigSave).
	c.saveConfigLocked()
	c.logger.Info("the panel's move was aborted; dropped its staged address", "move_id", req.GetMoveId())
	if c.cfgUnsaved {
		return stageError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, reasonConfig, "could not write config.yml; the agent tries again")
	}
	return nil
}

// CheckPrivateSession refuses a move step while the session being served
// is plain HTTP from another host, or there is none (PanelStager). what
// says what anyone on the path could do then.
func (c *connector) CheckPrivateSession(what string) error {
	c.cfgMu.Lock()
	session := c.sessionURL
	c.cfgMu.Unlock()
	if session == "" || PlainRemote(session) {
		return stageError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, reasonPlainHTTP,
			"this node connects to the panel over plain HTTP, where "+what+"; join it again with the https:// command (seylo join --force)")
	}
	return nil
}

// parseStagedTarget checks a staged address: https:// to a host and port
// only, with a pin.
func parseStagedTarget(raw, pin string) (panelTarget, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return panelTarget{}, fmt.Errorf("panel_url %q is not a URL like https://203.0.113.7:3443", raw)
	}
	if u.Scheme != "https" {
		return panelTarget{}, fmt.Errorf("panel_url %q must start with https://", raw)
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return panelTarget{}, fmt.Errorf("panel_url %q must be https://<host>:<port> only", raw)
	}
	if strings.TrimSpace(pin) == "" {
		return panelTarget{}, errors.New("panel_pin is required: the moved panel presents the agents' TLS key nodes pin")
	}
	b, err := conn.ParsePin(pin)
	if err != nil {
		return panelTarget{}, fmt.Errorf("panel_pin: %w", err)
	}
	return panelTarget{url: "https://" + u.Host, pin: conn.FormatPin(b)}, nil
}

// probePanel checks this node reaches target: a TLS handshake with the
// pin, through the proxy the agent's own connection uses, and any HTTP
// answer. No WebSocket: the old panel still holds this node's session.
func probePanel(ctx context.Context, target panelTarget) error {
	pin, err := conn.ParsePin(target.pin)
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = conn.PinnedTLSConfig(pin)
	transport.DisableKeepAlives = true
	defer transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, stageProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.url+"/api/health", nil)
	if err != nil {
		return err
	}
	res, err := (&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return err
	}
	return res.Body.Close()
}
