package rpc

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"strconv"

	"google.golang.org/protobuf/proto"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/conn"
)

// HelloContext prefixes every handshake signature (handshake.proto,
// ClientHello). The panel builds the same bytes in
// apps/panel/src/agent-hub/signature.ts.
const HelloContext = brand.Slug + "-agent-hello-v1"

// HelloSignedBytes returns what the agent signs:
//
//	HelloContext 0x00 panel_id 0x00 node_id 0x00 nonce
//
// node_id is empty when joining.
func HelloSignedBytes(panelID, nodeID string, nonce []byte) []byte {
	out := make([]byte, 0, len(HelloContext)+len(panelID)+len(nodeID)+3+len(nonce))
	out = append(out, HelloContext...)
	out = append(out, 0)
	out = append(out, panelID...)
	out = append(out, 0)
	out = append(out, nodeID...)
	out = append(out, 0)
	return append(out, nonce...)
}

// SignHello signs the ServerHello's nonce for nodeID ("" when joining).
func SignHello(key ed25519.PrivateKey, server *agentv1.ServerHello, nodeID string) []byte {
	return ed25519.Sign(key, HelloSignedBytes(server.GetPanelId(), nodeID, server.GetNonce()))
}

// VerifyHello checks a ClientHello signature against pub.
func VerifyHello(pub ed25519.PublicKey, panelID, nodeID string, nonce, signature []byte) bool {
	return len(pub) == ed25519.PublicKeySize && ed25519.Verify(pub, HelloSignedBytes(panelID, nodeID, nonce), signature)
}

// PanelAcceptContext prefixes the panel's HelloAccepted.panel_signature
// (handshake.proto).
const PanelAcceptContext = brand.Slug + "-panel-accept-v1"

// PanelAcceptSignedBytes returns what the panel signs with its identity
// key (the edge ticket key) in HelloAccepted.panel_signature:
//
//	PanelAcceptContext 0x00 panel_id 0x00 node_id 0x00 session_id 0x00
//	nonce 0x00 client_signature 0x00 panel_url 0x00 panel_pin
func PanelAcceptSignedBytes(server *agentv1.ServerHello, client *agentv1.ClientHello, acc *agentv1.HelloAccepted) []byte {
	var out []byte
	out = append(out, PanelAcceptContext...)
	for _, part := range [][]byte{
		[]byte(server.GetPanelId()), []byte(acc.GetNodeId()), []byte(acc.GetSessionId()), server.GetNonce(),
		clientSignature(client), []byte(acc.GetPanelUrl()), []byte(acc.GetPanelPin()),
	} {
		out = append(out, 0)
		out = append(out, part...)
	}
	return out
}

// clientSignature is the ClientHello's join or resume signature.
func clientSignature(c *agentv1.ClientHello) []byte {
	if j := c.GetJoin(); j != nil {
		return j.GetSignature()
	}
	return c.GetResume().GetSignature()
}

// SignPanelAccept makes HelloAccepted.panel_signature (fake panels in
// tests; the real panel is TypeScript).
func SignPanelAccept(key ed25519.PrivateKey, server *agentv1.ServerHello, client *agentv1.ClientHello, acc *agentv1.HelloAccepted) []byte {
	return ed25519.Sign(key, PanelAcceptSignedBytes(server, client, acc))
}

// VerifyPanelAccept checks HelloAccepted.panel_signature against pub.
func VerifyPanelAccept(pub ed25519.PublicKey, server *agentv1.ServerHello, client *agentv1.ClientHello, acc *agentv1.HelloAccepted) bool {
	return len(pub) == ed25519.PublicKeySize && ed25519.Verify(pub, PanelAcceptSignedBytes(server, client, acc), acc.GetPanelSignature())
}

// PanelRejectContext prefixes HelloRejected.panel_signature.
const PanelRejectContext = brand.Slug + "-panel-reject-v1"

// PanelRejectSignedBytes returns what the panel signs with its identity key
// in HelloRejected.panel_signature:
//
//	PanelRejectContext 0x00 panel_id 0x00 nonce 0x00 client_signature
//	0x00 reason 0x00 min_agent_version
//
// client is nil (empty client_signature) when no ClientHello arrived;
// reason is the enum's decimal number.
func PanelRejectSignedBytes(server *agentv1.ServerHello, client *agentv1.ClientHello, rej *agentv1.HelloRejected) []byte {
	var out []byte
	out = append(out, PanelRejectContext...)
	var sig []byte
	if client != nil {
		sig = clientSignature(client)
	}
	for _, part := range [][]byte{
		[]byte(server.GetPanelId()), server.GetNonce(), sig,
		[]byte(strconv.Itoa(int(rej.GetReason()))), []byte(rej.GetMinAgentVersion()),
	} {
		out = append(out, 0)
		out = append(out, part...)
	}
	return out
}

// SignPanelReject makes HelloRejected.panel_signature (fake panels in
// tests; the real panel is TypeScript).
func SignPanelReject(key ed25519.PrivateKey, server *agentv1.ServerHello, client *agentv1.ClientHello, rej *agentv1.HelloRejected) []byte {
	return ed25519.Sign(key, PanelRejectSignedBytes(server, client, rej))
}

// VerifyPanelReject checks HelloRejected.panel_signature against pub.
func VerifyPanelReject(pub ed25519.PublicKey, server *agentv1.ServerHello, client *agentv1.ClientHello, rej *agentv1.HelloRejected) bool {
	return len(pub) == ed25519.PublicKeySize && ed25519.Verify(pub, PanelRejectSignedBytes(server, client, rej), rej.GetPanelSignature())
}

// HandshakeResult is what the agent learns from a successful handshake.
type HandshakeResult struct {
	Server *agentv1.ServerHello
	// Client is the ClientHello the agent sent.
	Client   *agentv1.ClientHello
	Accepted *agentv1.HelloAccepted
}

// RejectedError is returned by AgentHandshake when the panel refused the
// agent (bad token, unknown node, agent too old, ...).
type RejectedError struct {
	Rejected *agentv1.HelloRejected
	// Server and Client are the hellos of the refused handshake, to check
	// Rejected.panel_signature with (VerifyPanelReject).
	Server *agentv1.ServerHello
	Client *agentv1.ClientHello
}

func (e *RejectedError) Error() string {
	return "panel rejected the agent: " + e.Rejected.GetReason().String() + ": " + e.Rejected.GetMessage()
}

// ErrHandshake wraps every handshake failure that is not a rejection: the
// peer sent something other than the expected step, or the connection
// dropped.
var ErrHandshake = errors.New("rpc: handshake failed")

// AgentHandshake runs the agent side of the stream 0 handshake: read
// ServerHello, send the ClientHello that hello builds from it (hello signs
// the nonce), then wait for HelloAccepted or HelloRejected (*RejectedError).
// ctx bounds the whole exchange.
func AgentHandshake(ctx context.Context, t conn.Transport, hello func(*agentv1.ServerHello) (*agentv1.ClientHello, error)) (*HandshakeResult, error) {
	step, err := readHandshake(ctx, t)
	if err != nil {
		return nil, err
	}
	server := step.GetServerHello()
	if server == nil {
		return nil, fmt.Errorf("%w: expected ServerHello, got %T", ErrHandshake, step.GetStep())
	}
	client, err := hello(server)
	if err != nil {
		return nil, err
	}
	if err := writeHandshake(ctx, t, &agentv1.Handshake{Step: &agentv1.Handshake_ClientHello{ClientHello: client}}); err != nil {
		return nil, err
	}
	step, err = readHandshake(ctx, t)
	if err != nil {
		return nil, err
	}
	switch s := step.GetStep().(type) {
	case *agentv1.Handshake_Accepted:
		return &HandshakeResult{Server: server, Client: client, Accepted: s.Accepted}, nil
	case *agentv1.Handshake_Rejected:
		return nil, &RejectedError{Rejected: s.Rejected, Server: server, Client: client}
	default:
		return nil, fmt.Errorf("%w: expected HelloAccepted or HelloRejected, got %T", ErrHandshake, s)
	}
}

// PanelHandshake runs the panel side (fake panels in tests; the real panel
// is TypeScript): send server, read the ClientHello, ask decide, and send
// its answer. It returns the ClientHello and the acceptance, or a
// *RejectedError after sending the rejection.
func PanelHandshake(ctx context.Context, t conn.Transport, server *agentv1.ServerHello, decide func(*agentv1.ClientHello) (*agentv1.HelloAccepted, *agentv1.HelloRejected)) (*agentv1.ClientHello, *agentv1.HelloAccepted, error) {
	if err := writeHandshake(ctx, t, &agentv1.Handshake{Step: &agentv1.Handshake_ServerHello{ServerHello: server}}); err != nil {
		return nil, nil, err
	}
	step, err := readHandshake(ctx, t)
	if err != nil {
		return nil, nil, err
	}
	client := step.GetClientHello()
	if client == nil {
		return nil, nil, fmt.Errorf("%w: expected ClientHello, got %T", ErrHandshake, step.GetStep())
	}
	accepted, rejected := decide(client)
	if rejected != nil {
		_ = writeHandshake(ctx, t, &agentv1.Handshake{Step: &agentv1.Handshake_Rejected{Rejected: rejected}})
		return client, nil, &RejectedError{Rejected: rejected}
	}
	if err := writeHandshake(ctx, t, &agentv1.Handshake{Step: &agentv1.Handshake_Accepted{Accepted: accepted}}); err != nil {
		return nil, nil, err
	}
	return client, accepted, nil
}

func readHandshake(ctx context.Context, t conn.Transport) (*agentv1.Handshake, error) {
	f, err := t.ReadFrame(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: reading: %w", ErrHandshake, err)
	}
	if f.Kind != conn.KindEvent || f.Stream != conn.ConnectionStream {
		return nil, fmt.Errorf("%w: expected EVENT on stream 0, got %s on stream %d", ErrHandshake, f.Kind, f.Stream)
	}
	h := &agentv1.Handshake{}
	if err := proto.Unmarshal(f.Payload, h); err != nil {
		return nil, fmt.Errorf("%w: undecodable handshake: %w", ErrHandshake, err)
	}
	return h, nil
}

func writeHandshake(ctx context.Context, t conn.Transport, h *agentv1.Handshake) error {
	payload, err := proto.Marshal(h)
	if err != nil {
		return fmt.Errorf("%w: encoding: %w", ErrHandshake, err)
	}
	if err := t.WriteFrame(ctx, conn.Frame{Kind: conn.KindEvent, Stream: conn.ConnectionStream, Payload: payload}.Encode()); err != nil {
		return fmt.Errorf("%w: writing: %w", ErrHandshake, err)
	}
	return nil
}
