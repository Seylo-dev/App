package rpc_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"testing"

	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
)

var update = flag.Bool("update", false, "rewrite testdata/envelopes.json")

// envelopeFixture is shared with the TypeScript side: each entry is an
// encoding both implementations must produce and accept byte for byte.
type envelopeFixture struct {
	Name string `json:"name"`
	// Kind says how to read Hex: "hello" (signed handshake bytes),
	// "call", "result", "open", "close" (envelope messages) or
	// "delimited" (a size-delimited LogsFollowResponse stream chunk).
	Kind string `json:"kind"`
	Hex  string `json:"hex"`
}

func goldenEnvelopes() []envelopeFixture {
	marshal := func(m proto.Message) string {
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(m)
		if err != nil {
			panic(err)
		}
		return hex.EncodeToString(b)
	}
	var delim bytes.Buffer
	for _, line := range []string{"first", "second line"} {
		_, _ = protodelim.MarshalTo(&delim, &agentv1.LogsFollowResponse{Entries: []*agentv1.LogEntry{{Line: line, Generation: 3}}})
	}
	nonce := bytes.Repeat([]byte{0x5a}, 32)
	return []envelopeFixture{
		{"join signature bytes", "hello", hex.EncodeToString(rpc.HelloSignedBytes("panel1", "", nonce))},
		{"resume signature bytes", "hello", hex.EncodeToString(rpc.HelloSignedBytes("panel1", "node1", nonce))},
		{"call with deadline and metadata", "call", marshal(&agentv1.Call{
			Method: "/seylo.agent.v1.AgentService/RestartService", Request: []byte{0x0a, 0x03, 'w', 'e', 'b'},
			Deadline: &timestamppb.Timestamp{Seconds: 1_800_000_000}, Metadata: map[string]string{"user_id": "u1"},
		})},
		{"ok result", "result", marshal(&agentv1.Result{Status: &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_OK}, Response: []byte{0x08, 0x01}})},
		{"not found result", "result", marshal(&agentv1.Result{Status: &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_NOT_FOUND, Message: "no such service"}})},
		{"open with window", "open", marshal(&agentv1.Open{Method: "/seylo.agent.v1.AgentService/LogsFollow", InitialWindow: 262144})},
		{"half close", "close", marshal(&agentv1.Close{Status: &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_OK}})},
		{"cancel", "close", marshal(&agentv1.Close{Status: &agentv1.Status{Code: agentv1.StatusCode_STATUS_CODE_CANCELLED, Message: "cancelled by the caller"}})},
		{"two delimited stream messages", "delimited", hex.EncodeToString(delim.Bytes())},
	}
}

func TestGoldenEnvelopes(t *testing.T) {
	const path = "testdata/envelopes.json"
	want := goldenEnvelopes()
	if *update {
		b, _ := json.MarshalIndent(want, "", "  ")
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got []envelopeFixture
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("fixture has %d entries, code makes %d: run go test -run TestGoldenEnvelopes -update", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s: fixture %s, code %s", want[i].Name, got[i].Hex, want[i].Hex)
		}
	}
	// The delimited chunk decodes back message by message.
	raw, _ := hex.DecodeString(want[len(want)-1].Hex)
	r := bytes.NewReader(raw)
	for _, line := range []string{"first", "second line"} {
		var m agentv1.LogsFollowResponse
		if err := protodelim.UnmarshalFrom(r, &m); err != nil || m.GetEntries()[0].GetLine() != line {
			t.Fatalf("delimited decode = %v, %v", &m, err)
		}
	}
}
