package rpctest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// FakePanel is an in-process panel for agent tests: the agent WebSocket
// endpoint over httptest, the stream 0 handshake with join tokens and node
// keys (the same rules as apps/panel/src/agent-hub/handshake.ts), and
// PanelService handlers that record reports and dedupe them by outbox id.
// Tests reach the agent through Session(nodeID).
type FakePanel struct {
	tb      testing.TB
	Server  *httptest.Server
	PanelID string
	// EdgeKey is sent as HelloAccepted.edge_ticket_public_key, the panel's
	// identity key; EdgePrivate is its private half, which signs
	// HelloAccepted.panel_signature after SignAccepts(true). Set both
	// before the first connection.
	EdgeKey     ed25519.PublicKey
	EdgePrivate ed25519.PrivateKey

	mu       sync.Mutex
	caps     []string
	tokens   map[string]bool // token -> used
	nodes    map[string]ed25519.PublicKey
	nextNode int
	sessions map[string]*rpc.Session
	hellos   []*agentv1.ClientHello
	rejects  []*agentv1.HelloRejected
	reports  []Report
	seen     map[uint64]bool
	failWith *rpc.Error
	// hang makes report handlers wait for the call's end without answering.
	hang bool
	// minAgent, when set, refuses every agent as too old.
	minAgent string
	desired  *agentv1.DesiredState
	events   []*agentv1.Event
	changed  chan struct{}
	mux      *http.ServeMux
	// moveURL and movePin go out in every HelloAccepted (panel_url,
	// panel_pin).
	moveURL, movePin string
	// hosts is the Host header of every accepted connection, in order.
	hosts []string
	// linger keeps an ended session registered this long.
	linger time.Duration
	// drops counts DropConnections calls. A connection accepted before the
	// latest one ends instead of registering its session.
	drops uint64
	// signAccepts adds HelloAccepted.panel_signature.
	signAccepts bool
	// refuseAgents answers /api/agent/connect with 503, like a retired
	// panel or a moved one before its switch.
	refuseAgents bool
	// connects counts /api/agent/connect requests, refused ones included.
	connects int
	// healthMove is the "moveId" /api/health names ("" for none).
	healthMove string
}

// Report is one delivered outbox report.
type Report struct {
	NodeID   string
	OutboxID uint64
	Crash    *agentv1.CrashReport
	Event    *agentv1.Event
}

// FakePanelOption configures NewFakePanel.
type FakePanelOption func(*fakePanelConfig)

type fakePanelConfig struct {
	tls  bool
	caps []string
}

// WithTLS serves the endpoint over TLS with httptest's self-signed
// certificate (for pin and trust-on-first-use tests).
func WithTLS() FakePanelOption { return func(c *fakePanelConfig) { c.tls = true } }

// WithPanelCapabilities replaces the advertised capabilities (default:
// panel.report.v1 and panel.desired.v1).
func WithPanelCapabilities(caps ...string) FakePanelOption {
	return func(c *fakePanelConfig) { c.caps = caps }
}

// NewFakePanel starts a fake panel; it stops with the test.
func NewFakePanel(tb testing.TB, opts ...FakePanelOption) *FakePanel {
	cfg := fakePanelConfig{caps: []string{"panel.report.v1", "panel.desired.v1"}}
	for _, o := range opts {
		o(&cfg)
	}
	edge, edgePriv, _ := ed25519.GenerateKey(rand.Reader)
	p := &FakePanel{
		tb: tb, PanelID: "fakepanel", EdgeKey: edge, EdgePrivate: edgePriv, caps: cfg.caps,
		tokens: map[string]bool{}, nodes: map[string]ed25519.PublicKey{}, sessions: map[string]*rpc.Session{},
		seen: map[uint64]bool{}, changed: make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/agent/connect", p.serveAgent)
	mux.HandleFunc("/api/health", p.serveHealth)
	p.mux = mux
	if cfg.tls {
		p.Server = httptest.NewTLSServer(mux)
	} else {
		p.Server = httptest.NewServer(mux)
	}
	tb.Cleanup(func() {
		p.DropConnections()
		p.Server.Close()
	})
	return p
}

// URL is the panel's base URL (what config.yml holds).
func (p *FakePanel) URL() string { return p.Server.URL }

// SPKI is the SHA-256 of the TLS certificate's public key (TLS panels).
func (p *FakePanel) SPKI() []byte {
	return conn.SPKIFingerprint(p.Server.Certificate())
}

// ServeTLS starts one more listener for the same panel, over TLS with
// httptest's certificate (a second address, like the panel's domain). It
// stops with the test.
func (p *FakePanel) ServeTLS() *httptest.Server {
	srv := httptest.NewTLSServer(p.mux)
	p.tb.Cleanup(func() {
		p.DropConnections()
		srv.Close()
	})
	return srv
}

// SignAccepts makes every HelloAccepted and HelloRejected carry
// panel_signature (a panel that proves its identity key) or not.
func (p *FakePanel) SignAccepts(sign bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.signAccepts = sign
}

// SetPanelAddress makes every HelloAccepted name this panel_url and
// panel_pin ("" for neither).
func (p *FakePanel) SetPanelAddress(url, pin string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.moveURL, p.movePin = url, pin
}

// AcceptedHosts returns the Host header of every accepted connection, in
// order.
func (p *FakePanel) AcceptedHosts() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.hosts)
}

// NodeKey returns the public key a node joined with (nil when unknown).
func (p *FakePanel) NodeKey(nodeID string) ed25519.PublicKey {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.nodes[nodeID])
}

// AddNode makes the panel accept resumes of nodeID signed with pub, like a
// node that joined it earlier.
func (p *FakePanel) AddNode(nodeID string, pub ed25519.PublicKey) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nodes[nodeID] = slices.Clone(pub)
}

// HoldClosedSessions keeps a session that ended registered for d, like a
// panel that notices a closed connection late: a resume in that time gets
// ALREADY_CONNECTED.
func (p *FakePanel) HoldClosedSessions(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.linger = d
}

// AddJoinToken makes token valid for one join.
func (p *FakePanel) AddJoinToken(token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens[token] = false
}

// FailReports makes ReportCrash/ReportEvent answer err (nil: succeed).
func (p *FakePanel) FailReports(err *rpc.Error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failWith = err
}

// HangReports makes ReportCrash/ReportEvent wait without answering until
// the agent gives up on the call (a panel whose handler is wedged).
func (p *FakePanel) HangReports(hang bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hang = hang
}

// SetDesired is what GetDesiredState returns.
func (p *FakePanel) SetDesired(d *agentv1.DesiredState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.desired = d
}

func (p *FakePanel) notify() {
	close(p.changed)
	p.changed = make(chan struct{})
}

// waitFor polls cond (under p.mu) until it holds.
func (p *FakePanel) waitFor(what string, cond func() bool) {
	p.tb.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		p.mu.Lock()
		ok := cond()
		ch := p.changed
		p.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-ch:
		case <-deadline.C:
			p.tb.Fatalf("fake panel: timed out waiting for %s", what)
		}
	}
}

// WaitConnected waits until n distinct sessions were accepted in total
// and one is live for nodeID ("" = any), and returns that node's id.
func (p *FakePanel) WaitConnected(nodeID string) string {
	p.tb.Helper()
	var got string
	p.waitFor("an agent connection", func() bool {
		for id := range p.sessions {
			if nodeID == "" || id == nodeID {
				got = id
				return true
			}
		}
		return false
	})
	return got
}

// WaitDisconnected waits until nodeID has no live session, after the agent
// stopped. Not after DropConnections: that returns once its sessions are
// gone, and an agent that reconnects at once may leave no moment without
// a session to see.
func (p *FakePanel) WaitDisconnected(nodeID string) {
	p.tb.Helper()
	p.waitFor("the agent to disconnect", func() bool { return p.sessions[nodeID] == nil })
}

// Session returns the live session of nodeID, for calling the agent.
func (p *FakePanel) Session(nodeID string) *rpc.Session {
	p.WaitConnected(nodeID)
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[nodeID]
}

// DropConnections closes every agent session, like a panel restart, and
// returns once the panel no longer holds them (HoldClosedSessions' time
// included): a resume after it is not refused as already connected, and
// the session of an agent that reconnected at once may already be live.
// A connection whose hello was already accepted (it is in AcceptedHosts and
// Hellos) but whose session is not registered yet ends instead of
// registering, so a test that waited for the accept and then drops never
// leaves that session up.
func (p *FakePanel) DropConnections() {
	p.tb.Helper()
	p.mu.Lock()
	p.drops++
	dropped := maps.Clone(p.sessions)
	p.mu.Unlock()
	for _, s := range dropped {
		s.Close(nil)
		<-s.Done()
	}
	p.waitFor("the dropped sessions to end", func() bool {
		for id, s := range dropped {
			if p.sessions[id] == s {
				return false
			}
		}
		return true
	})
}

// Hellos returns every ClientHello received, in order.
func (p *FakePanel) Hellos() []*agentv1.ClientHello {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.hellos)
}

// WaitRejected waits for the n-th rejection and returns it.
func (p *FakePanel) WaitRejected(n int) *agentv1.HelloRejected {
	p.tb.Helper()
	var got *agentv1.HelloRejected
	p.waitFor(fmt.Sprintf("rejection %d", n), func() bool {
		if len(p.rejects) >= n {
			got = p.rejects[n-1]
			return true
		}
		return false
	})
	return got
}

// WaitEvent waits for a best-effort event matching match.
func (p *FakePanel) WaitEvent(match func(*agentv1.Event) bool) *agentv1.Event {
	p.tb.Helper()
	var got *agentv1.Event
	p.waitFor("a matching event", func() bool {
		for _, ev := range p.events {
			if match(ev) {
				got = ev
				return true
			}
		}
		return false
	})
	return got
}

// Reports returns the reports delivered so far (deduped), in order.
func (p *FakePanel) Reports() []Report {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.reports)
}

// WaitReports waits until at least n reports arrived and returns them.
func (p *FakePanel) WaitReports(n int) []Report {
	p.tb.Helper()
	p.waitFor(fmt.Sprintf("%d reports", n), func() bool { return len(p.reports) >= n })
	return p.Reports()
}

// RefuseAgents makes /api/agent/connect answer 503 with Retry-After before
// any WebSocket (refuse true), like a retired panel or a moved panel
// before its switch, or take agents again (false).
func (p *FakePanel) RefuseAgents(refuse bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refuseAgents = refuse
}

// Connects counts the requests to /api/agent/connect, refused ones too.
func (p *FakePanel) Connects() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.connects
}

// WaitConnects waits until /api/agent/connect got n requests in total.
func (p *FakePanel) WaitConnects(n int) {
	p.tb.Helper()
	p.waitFor(fmt.Sprintf("%d connect requests", n), func() bool { return p.connects >= n })
}

// SetHealthMove makes /api/health name this move ("moveId"), as a moved
// panel does while it waits for its switch ("" for none).
func (p *FakePanel) SetHealthMove(moveID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.healthMove = moveID
}

func (p *FakePanel) serveHealth(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	body := map[string]string{"status": "ok", "version": "test"}
	if p.healthMove != "" {
		body["moveId"] = p.healthMove
	}
	p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (p *FakePanel) serveAgent(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.connects++
	refuse := p.refuseAgents
	p.notify()
	p.mu.Unlock()
	if refuse {
		w.Header().Set("Retry-After", "10")
		http.Error(w, "this panel does not take agents now", http.StatusServiceUnavailable)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{conn.Subprotocol}})
	if err != nil {
		return
	}
	t := conn.NewWebSocket(c)
	ctx := r.Context()
	nonce := make([]byte, 32)
	_, _ = rand.Read(nonce)
	p.mu.Lock()
	caps := slices.Clone(p.caps)
	p.mu.Unlock()
	server := &agentv1.ServerHello{PanelId: p.PanelID, PanelVersion: "test", Nonce: nonce, Capabilities: caps}

	var nodeID string
	// drops is p.drops when the hello was accepted.
	var drops uint64
	hctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	hello, _, err := rpc.PanelHandshake(hctx, t, server, func(h *agentv1.ClientHello) (*agentv1.HelloAccepted, *agentv1.HelloRejected) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.hellos = append(p.hellos, proto.Clone(h).(*agentv1.ClientHello))
		id, rej := p.decide(h, nonce)
		if rej != nil {
			if p.signAccepts {
				rej.PanelSignature = rpc.SignPanelReject(p.EdgePrivate, server, h, rej)
			}
			p.rejects = append(p.rejects, rej)
			p.notify()
			return nil, rej
		}
		nodeID, drops = id, p.drops
		p.hosts = append(p.hosts, r.Host)
		acc := &agentv1.HelloAccepted{NodeId: id, SessionId: fmt.Sprintf("s%d", len(p.hellos)), EdgeTicketPublicKey: p.EdgeKey,
			PanelUrl: p.moveURL, PanelPin: p.movePin}
		if p.signAccepts {
			acc.PanelSignature = rpc.SignPanelAccept(p.EdgePrivate, server, h, acc)
		}
		return acc, nil
	})
	cancel()
	if err != nil {
		_ = t.Close("rejected")
		return
	}

	session := rpc.NewSession(rpc.SessionConfig{
		Transport:        t,
		Role:             conn.RoleAcceptor,
		Handlers:         p.handlers(nodeID),
		PeerCapabilities: hello.GetFacts().GetCapabilities(),
		OnEvent: func(ev *agentv1.Event) {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.events = append(p.events, ev)
			p.notify()
		},
	})
	p.mu.Lock()
	if p.drops != drops {
		// DropConnections ran between the accept and here.
		p.mu.Unlock()
		_ = session.Close(nil)
		return
	}
	p.sessions[nodeID] = session
	p.notify()
	p.mu.Unlock()
	_ = session.Serve(context.Background())
	p.mu.Lock()
	linger := p.linger
	p.mu.Unlock()
	time.Sleep(linger)
	p.mu.Lock()
	if p.sessions[nodeID] == session {
		delete(p.sessions, nodeID)
	}
	p.notify()
	p.mu.Unlock()
}

// RefuseAgentsOlderThan makes the panel refuse every agent with
// HELLO_REJECT_REASON_AGENT_TOO_OLD and this minimum ("" accepts again).
func (p *FakePanel) RefuseAgentsOlderThan(version string) {
	p.mu.Lock()
	p.minAgent = version
	p.mu.Unlock()
}

// decide applies the panel's join and resume rules. Caller holds p.mu.
func (p *FakePanel) decide(h *agentv1.ClientHello, nonce []byte) (string, *agentv1.HelloRejected) {
	reject := func(reason agentv1.HelloRejectReason, msg string) (string, *agentv1.HelloRejected) {
		return "", &agentv1.HelloRejected{Reason: reason, Message: msg}
	}
	if p.minAgent != "" {
		return "", &agentv1.HelloRejected{Reason: agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD,
			Message: "agent too old", MinAgentVersion: p.minAgent}
	}
	switch cred := h.GetCredential().(type) {
	case *agentv1.ClientHello_Resume:
		id := cred.Resume.GetNodeId()
		pub, ok := p.nodes[id]
		if !ok {
			return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_UNKNOWN_NODE, "unknown node")
		}
		if !rpc.VerifyHello(pub, p.PanelID, id, nonce, cred.Resume.GetSignature()) {
			return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_BAD_SIGNATURE, "bad signature")
		}
		if p.sessions[id] != nil {
			return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_ALREADY_CONNECTED, "already connected")
		}
		return id, nil
	case *agentv1.ClientHello_Join:
		used, ok := p.tokens[cred.Join.GetToken()]
		if !ok || used {
			return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_INVALID_TOKEN, "invalid token")
		}
		pub := ed25519.PublicKey(cred.Join.GetPublicKey())
		if !rpc.VerifyHello(pub, p.PanelID, "", nonce, cred.Join.GetSignature()) {
			return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_BAD_SIGNATURE, "bad join signature")
		}
		p.tokens[cred.Join.GetToken()] = true
		p.nextNode++
		id := fmt.Sprintf("node%d", p.nextNode)
		p.nodes[id] = slices.Clone(pub)
		return id, nil
	default:
		return reject(agentv1.HelloRejectReason_HELLO_REJECT_REASON_INVALID_TOKEN, "no credential")
	}
}

func (p *FakePanel) handlers(nodeID string) *rpc.Mux {
	mux := rpc.NewPanelMux()
	record := func(ctx context.Context, r Report) error {
		p.mu.Lock()
		if p.hang {
			p.mu.Unlock()
			<-ctx.Done()
			return ctx.Err()
		}
		defer p.mu.Unlock()
		if p.failWith != nil {
			return p.failWith
		}
		if !p.seen[r.OutboxID] {
			p.seen[r.OutboxID] = true
			p.reports = append(p.reports, r)
			p.notify()
		}
		return nil
	}
	rpc.HandleUnary(mux, "ReportCrash", func(ctx context.Context, req *agentv1.ReportCrashRequest) (*agentv1.ReportCrashResponse, error) {
		return &agentv1.ReportCrashResponse{}, record(ctx, Report{NodeID: nodeID, OutboxID: req.GetOutboxId(), Crash: req.GetReport()})
	})
	rpc.HandleUnary(mux, "ReportEvent", func(ctx context.Context, req *agentv1.ReportEventRequest) (*agentv1.ReportEventResponse, error) {
		return &agentv1.ReportEventResponse{}, record(ctx, Report{NodeID: nodeID, OutboxID: req.GetOutboxId(), Event: req.GetEvent()})
	})
	rpc.HandleUnary(mux, "GetDesiredState", func(ctx context.Context, req *agentv1.GetDesiredStateRequest) (*agentv1.GetDesiredStateResponse, error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.desired == nil || p.desired.GetRevision() <= req.GetKnownRevision() {
			return &agentv1.GetDesiredStateResponse{}, nil
		}
		return &agentv1.GetDesiredStateResponse{State: proto.Clone(p.desired).(*agentv1.DesiredState)}, nil
	})
	rpc.HandleRaw(mux, "RegistryTunnel", func(ctx context.Context, req *agentv1.RegistryTunnelRequest, s rpc.RawStream) (*agentv1.RegistryTunnelResponse, error) {
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNIMPLEMENTED, "the fake panel has no registry")
	})
	return mux
}
