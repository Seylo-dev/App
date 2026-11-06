package conn

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var update = flag.Bool("update", false, "rewrite testdata golden files")

func TestKindsMatchProto(t *testing.T) {
	want := map[Kind]agentv1.FrameKind{
		KindCall:   agentv1.FrameKind_FRAME_KIND_CALL,
		KindResult: agentv1.FrameKind_FRAME_KIND_RESULT,
		KindEvent:  agentv1.FrameKind_FRAME_KIND_EVENT,
		KindOpen:   agentv1.FrameKind_FRAME_KIND_OPEN,
		KindData:   agentv1.FrameKind_FRAME_KIND_DATA,
		KindWindow: agentv1.FrameKind_FRAME_KIND_WINDOW,
		KindClose:  agentv1.FrameKind_FRAME_KIND_CLOSE,
	}
	for kind, protoKind := range want {
		if int32(kind) != int32(protoKind) {
			t.Errorf("%s = %d, proto says %d", kind, kind, protoKind)
		}
	}
	// Every non-zero proto value must be a kind this package handles, so a
	// new FrameKind cannot land in the proto without the codec learning it.
	for name, value := range agentv1.FrameKind_value {
		if value == 0 {
			continue
		}
		if !Kind(value).Valid() {
			t.Errorf("proto kind %s (%d) is not Valid() in conn", name, value)
		}
	}
	if Kind(0).Valid() || Kind(8).Valid() {
		t.Error("kinds outside the enum must be invalid")
	}
}

func TestKindString(t *testing.T) {
	if got := KindWindow.String(); got != "WINDOW" {
		t.Errorf("KindWindow.String() = %q", got)
	}
	if got := Kind(42).String(); got != "Kind(42)" {
		t.Errorf("Kind(42).String() = %q", got)
	}
}

func TestOnlyDataIsFlowControlled(t *testing.T) {
	for k := KindCall; k <= KindClose; k++ {
		if got, want := k.IsControl(), k != KindData; got != want {
			t.Errorf("%s.IsControl() = %v", k, got)
		}
	}
}

func TestFrameRoundTrip(t *testing.T) {
	frames := []Frame{
		{Kind: KindCall, Stream: 1, Payload: []byte("call")},
		{Kind: KindEvent, Stream: ConnectionStream, Payload: nil},
		{Kind: KindData, Stream: 0xFFFFFFFF, Payload: bytes.Repeat([]byte{0xAB}, MaxDataChunk)},
	}
	for _, f := range frames {
		got, err := ParseFrame(f.Encode())
		if err != nil {
			t.Fatalf("parse %s: %v", f.Kind, err)
		}
		if got.Kind != f.Kind || got.Stream != f.Stream || !bytes.Equal(got.Payload, f.Payload) {
			t.Fatalf("round trip changed the frame: %+v -> %+v", f, got)
		}
	}
}

func TestAppendFrameReusesBuffer(t *testing.T) {
	buf := make([]byte, 0, 64)
	out := AppendFrame(buf, Frame{Kind: KindClose, Stream: 3, Payload: []byte{1}})
	if &out[0] != &buf[:1][0] {
		t.Fatal("AppendFrame allocated although the buffer had room")
	}
}

func TestParseFrameErrors(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		want  error
	}{
		{"empty", nil, ErrShortFrame},
		{"header cut", []byte{byte(KindCall), 0, 0, 1}, ErrShortFrame},
		{"kind zero", []byte{0, 0, 0, 0, 1}, ErrUnknownKind},
		{"kind too high", []byte{8, 0, 0, 0, 1}, ErrUnknownKind},
		{"too large", make([]byte, MaxFrameSize+1), ErrFrameTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ParseFrame(tt.input); !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestWindowPayload(t *testing.T) {
	f := WindowFrame(7, 65536)
	n, err := ParseWindow(f.Payload)
	if err != nil || n != 65536 {
		t.Fatalf("ParseWindow = %d, %v", n, err)
	}
	for _, bad := range [][]byte{nil, {0, 0, 1}, {0, 0, 0, 0}, {0, 0, 0, 1, 0}} {
		if _, err := ParseWindow(bad); !errors.Is(err, ErrBadWindow) {
			t.Errorf("ParseWindow(%v) err = %v", bad, err)
		}
	}
}

// goldenFrame is one entry of testdata/frames.json. The TypeScript codec in
// packages/proto reads the same file, which keeps both encoders identical.
type goldenFrame struct {
	Name    string `json:"name"`
	Kind    uint8  `json:"kind"`
	Stream  uint32 `json:"stream"`
	Payload string `json:"payloadHex"`
	Encoded string `json:"encodedHex"`
}

func goldenFrames() []goldenFrame {
	cases := []struct {
		name  string
		frame Frame
	}{
		{"event on connection stream", Frame{Kind: KindEvent, Stream: ConnectionStream, Payload: []byte{0x0a, 0x00}}},
		{"call from dialer", Frame{Kind: KindCall, Stream: 1, Payload: []byte("hello")}},
		{"result to dialer", Frame{Kind: KindResult, Stream: 1, Payload: []byte{}}},
		{"open from acceptor", Frame{Kind: KindOpen, Stream: 2, Payload: []byte{0x08, 0x01}}},
		{"data max stream id", Frame{Kind: KindData, Stream: 0xFFFFFFFF, Payload: []byte{0x00, 0xFF}}},
		{"window grant", WindowFrame(258, 0x00040000)},
		{"close", Frame{Kind: KindClose, Stream: 0x01020304, Payload: []byte{0x0a, 0x02, 0x08, 0x01}}},
	}
	out := make([]goldenFrame, 0, len(cases))
	for _, c := range cases {
		out = append(out, goldenFrame{
			Name:    c.name,
			Kind:    uint8(c.frame.Kind),
			Stream:  uint32(c.frame.Stream),
			Payload: hex.EncodeToString(c.frame.Payload),
			Encoded: hex.EncodeToString(c.frame.Encode()),
		})
	}
	return out
}

func TestGoldenFrames(t *testing.T) {
	path := filepath.Join("testdata", "frames.json")
	want, err := json.MarshalIndent(goldenFrames(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')

	if *update {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run `go test ./internal/conn -run Golden -update`)", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("testdata/frames.json is stale; the frame encoding changed. Run with -update only if the change is intended, and update the TypeScript codec too.")
	}
}

func FuzzParseFrame(f *testing.F) {
	for _, g := range goldenFrames() {
		b, _ := hex.DecodeString(g.Encoded)
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		fr, err := ParseFrame(b)
		if err != nil {
			return
		}
		if !bytes.Equal(fr.Encode(), b) {
			t.Fatalf("re-encoding a parsed frame changed it")
		}
	})
}
