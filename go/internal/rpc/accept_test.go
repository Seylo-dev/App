package rpc_test

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// The bytes the panel signs in HelloAccepted.panel_signature, and the
// signature with the key from seed 0..31 (the same key as the edge ticket
// fixture in apps/panel and edge_test.go): the reference vector for the
// panel's TypeScript signer.
func TestPanelAcceptSignatureVector(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	key := ed25519.NewKeyFromSeed(seed)
	server := &agentv1.ServerHello{PanelId: "panel1", Nonce: bytes.Repeat([]byte{0x5a}, 32)}
	client := &agentv1.ClientHello{Credential: &agentv1.ClientHello_Resume{Resume: &agentv1.ResumeCredential{NodeId: "node1", Signature: bytes.Repeat([]byte{0xa5}, 64)}}}
	acc := &agentv1.HelloAccepted{NodeId: "node1", SessionId: "s1", PanelUrl: "https://panel.example.com"}

	wantBytes := "7365796c6f2d70616e656c2d6163636570742d7631" + // context
		"0070616e656c31" + "006e6f646531" + "00" + "7331" + // panel1, node1, s1
		"00" + strings.Repeat("5a", 32) + "00" + strings.Repeat("a5", 64) + // nonce, client signature
		"0068747470733a2f2f70616e656c2e6578616d706c652e636f6d" + "00" // panel url, empty pin
	const wantSig = "b5d7c1c0d75392e54337776bd4c86d6590eef93f6ff2dc5d94835b5bb4ecaa3c7202f05252a4e80dc4c27cbd631814725cd99301fb4ade0230a836dfdc416508"
	if got := hex.EncodeToString(rpc.PanelAcceptSignedBytes(server, client, acc)); got != wantBytes {
		t.Fatalf("signed bytes\n got %s\nwant %s", got, wantBytes)
	}
	sig := rpc.SignPanelAccept(key, server, client, acc)
	if got := hex.EncodeToString(sig); got != wantSig {
		t.Fatalf("signature %s, want %s", got, wantSig)
	}
	acc.PanelSignature = sig
	pub := key.Public().(ed25519.PublicKey)
	if !rpc.VerifyPanelAccept(pub, server, client, acc) {
		t.Fatal("the vector does not verify")
	}
	// Every signed field matters: another value fails.
	for name, change := range map[string]func(s *agentv1.ServerHello, c *agentv1.ClientHello, a *agentv1.HelloAccepted){
		"panel id": func(s *agentv1.ServerHello, _ *agentv1.ClientHello, _ *agentv1.HelloAccepted) { s.PanelId = "panel2" },
		"nonce":    func(s *agentv1.ServerHello, _ *agentv1.ClientHello, _ *agentv1.HelloAccepted) { s.Nonce[0] ^= 1 },
		"client sig": func(_ *agentv1.ServerHello, c *agentv1.ClientHello, _ *agentv1.HelloAccepted) {
			c.GetResume().Signature[0] ^= 1
		},
		"node id":    func(_ *agentv1.ServerHello, _ *agentv1.ClientHello, a *agentv1.HelloAccepted) { a.NodeId = "node2" },
		"session id": func(_ *agentv1.ServerHello, _ *agentv1.ClientHello, a *agentv1.HelloAccepted) { a.SessionId = "s2" },
		"panel url": func(_ *agentv1.ServerHello, _ *agentv1.ClientHello, a *agentv1.HelloAccepted) {
			a.PanelUrl = "https://evil.example"
		},
		"panel pin": func(_ *agentv1.ServerHello, _ *agentv1.ClientHello, a *agentv1.HelloAccepted) {
			a.PanelPin = "sha256:00"
		},
	} {
		s, c, a := proto.Clone(server).(*agentv1.ServerHello), proto.Clone(client).(*agentv1.ClientHello), proto.Clone(acc).(*agentv1.HelloAccepted)
		change(s, c, a)
		if rpc.VerifyPanelAccept(pub, s, c, a) {
			t.Errorf("%s changed, the signature still verifies", name)
		}
	}
	// A join signs over the join signature.
	join := &agentv1.ClientHello{Credential: &agentv1.ClientHello_Join{Join: &agentv1.JoinCredential{Signature: bytes.Repeat([]byte{0x11}, 64)}}}
	acc.PanelSignature = rpc.SignPanelAccept(key, server, join, acc)
	if !rpc.VerifyPanelAccept(pub, server, join, acc) || rpc.VerifyPanelAccept(pub, server, client, acc) {
		t.Fatal("the join signature is not what the accept covers")
	}
}

// The bytes and signature of HelloRejected.panel_signature with the same
// key: the reference vector for the panel's signReject.
func TestPanelRejectSignatureVector(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	key := ed25519.NewKeyFromSeed(seed)
	server := &agentv1.ServerHello{PanelId: "panel1", Nonce: bytes.Repeat([]byte{0x5a}, 32)}
	client := &agentv1.ClientHello{Credential: &agentv1.ClientHello_Resume{Resume: &agentv1.ResumeCredential{NodeId: "node1", Signature: bytes.Repeat([]byte{0xa5}, 64)}}}
	rej := &agentv1.HelloRejected{Reason: agentv1.HelloRejectReason_HELLO_REJECT_REASON_AGENT_TOO_OLD, Message: "not signed", MinAgentVersion: "0.2.0"}

	wantBytes := "7365796c6f2d70616e656c2d72656a6563742d7631" + // context
		"0070616e656c31" + "00" + strings.Repeat("5a", 32) + "00" + strings.Repeat("a5", 64) + // panel1, nonce, client signature
		"0035" + "00302e322e30" // reason 5, "0.2.0"
	if got := hex.EncodeToString(rpc.PanelRejectSignedBytes(server, client, rej)); got != wantBytes {
		t.Fatalf("signed bytes\n got %s\nwant %s", got, wantBytes)
	}
	const wantSig = "6df46e1e0d9401d70b16fa32b4369b2748f72832659e168a5134c216e4ddfbe4cbc8935f6b638166ec724e0209f22e4bf31a3eb4837275d3eaf5f6042002a905"
	sig := rpc.SignPanelReject(key, server, client, rej)
	if got := hex.EncodeToString(sig); got != wantSig {
		t.Fatalf("signature %s, want %s", got, wantSig)
	}
	rej.PanelSignature = sig
	pub := key.Public().(ed25519.PublicKey)
	if !rpc.VerifyPanelReject(pub, server, client, rej) {
		t.Fatal("the vector does not verify")
	}
	// The message is not signed (shown only); everything the agent acts on is.
	rej.Message = "changed"
	if !rpc.VerifyPanelReject(pub, server, client, rej) {
		t.Fatal("the message should not be signed")
	}
	for name, change := range map[string]func(r *agentv1.HelloRejected, s *agentv1.ServerHello, c *agentv1.ClientHello){
		"reason": func(r *agentv1.HelloRejected, _ *agentv1.ServerHello, _ *agentv1.ClientHello) {
			r.Reason = agentv1.HelloRejectReason_HELLO_REJECT_REASON_UNKNOWN_NODE
		},
		"min version": func(r *agentv1.HelloRejected, _ *agentv1.ServerHello, _ *agentv1.ClientHello) {
			r.MinAgentVersion = "9.9.9"
		},
		"nonce": func(_ *agentv1.HelloRejected, s *agentv1.ServerHello, _ *agentv1.ClientHello) { s.Nonce[0] ^= 1 },
		"client sig": func(_ *agentv1.HelloRejected, _ *agentv1.ServerHello, c *agentv1.ClientHello) {
			c.GetResume().Signature[0] ^= 1
		},
	} {
		r, s, c := proto.Clone(rej).(*agentv1.HelloRejected), proto.Clone(server).(*agentv1.ServerHello), proto.Clone(client).(*agentv1.ClientHello)
		change(r, s, c)
		if rpc.VerifyPanelReject(pub, s, c, r) {
			t.Errorf("%s is not covered by the signature", name)
		}
	}
	// No ClientHello (the hello timed out): an empty client signature.
	none := rpc.PanelRejectSignedBytes(server, nil, rej)
	if !bytes.Contains(none, []byte{0, 0, '5'}) {
		t.Fatalf("without a client hello: %x", none)
	}
}
