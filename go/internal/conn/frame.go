package conn

import (
	"encoding/binary"
	"errors"
	"fmt"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Kind is the first byte of a frame.
type Kind uint8

// Frame kinds. Values must equal agentv1.FrameKind; TestKindsMatchProto
// enforces it.
const (
	KindCall   = Kind(agentv1.FrameKind_FRAME_KIND_CALL)
	KindResult = Kind(agentv1.FrameKind_FRAME_KIND_RESULT)
	KindEvent  = Kind(agentv1.FrameKind_FRAME_KIND_EVENT)
	KindOpen   = Kind(agentv1.FrameKind_FRAME_KIND_OPEN)
	KindData   = Kind(agentv1.FrameKind_FRAME_KIND_DATA)
	KindWindow = Kind(agentv1.FrameKind_FRAME_KIND_WINDOW)
	KindClose  = Kind(agentv1.FrameKind_FRAME_KIND_CLOSE)
)

// Valid reports whether k is a kind this version understands.
func (k Kind) Valid() bool {
	return k >= KindCall && k <= KindClose
}

// IsControl reports whether frames of this kind skip the DATA queue and
// flow control. Everything except DATA is control.
func (k Kind) IsControl() bool {
	return k != KindData
}

func (k Kind) String() string {
	if name, ok := agentv1.FrameKind_name[int32(k)]; ok && k.Valid() {
		return name[len("FRAME_KIND_"):]
	}
	return fmt.Sprintf("Kind(%d)", uint8(k))
}

// StreamID identifies a call or stream within one connection.
type StreamID uint32

// ConnectionStream is stream 0: the handshake and events travel on it.
const ConnectionStream StreamID = 0

const (
	// HeaderSize is the size of the fixed frame header.
	HeaderSize = 1 + 4

	// MaxFrameSize bounds a whole frame. Control payloads (a full desired
	// state with file mounts, a state snapshot) must fit; bulk bytes are
	// chunked well below it.
	MaxFrameSize = 16 << 20

	// MaxDataChunk is the largest DATA payload the Writer sends at once.
	// Small enough to interleave streams finely, large enough that header
	// and syscall overhead stay negligible.
	MaxDataChunk = 32 << 10
)

// Frame is one decoded frame. Payload may alias the buffer it was parsed
// from; copy it before keeping it past the next read.
type Frame struct {
	Kind    Kind
	Stream  StreamID
	Payload []byte
}

// Parse errors. They mean the peer violated the protocol, so the
// connection should be closed.
var (
	ErrShortFrame    = errors.New("conn: frame shorter than its header")
	ErrUnknownKind   = errors.New("conn: unknown frame kind")
	ErrFrameTooLarge = errors.New("conn: frame exceeds MaxFrameSize")
	ErrBadWindow     = errors.New("conn: WINDOW payload must be a non-zero uint32")
)

// AppendFrame appends the encoding of f to dst and returns the result.
func AppendFrame(dst []byte, f Frame) []byte {
	dst = append(dst, byte(f.Kind))
	dst = binary.BigEndian.AppendUint32(dst, uint32(f.Stream))
	return append(dst, f.Payload...)
}

// Encode returns the encoding of f in a new buffer.
func (f Frame) Encode() []byte {
	return AppendFrame(make([]byte, 0, HeaderSize+len(f.Payload)), f)
}

// ParseFrame decodes one frame. The returned payload aliases b.
func ParseFrame(b []byte) (Frame, error) {
	if len(b) < HeaderSize {
		return Frame{}, ErrShortFrame
	}
	if len(b) > MaxFrameSize {
		return Frame{}, ErrFrameTooLarge
	}
	kind := Kind(b[0])
	if !kind.Valid() {
		return Frame{}, fmt.Errorf("%w: %d", ErrUnknownKind, b[0])
	}
	return Frame{
		Kind:    kind,
		Stream:  StreamID(binary.BigEndian.Uint32(b[1:HeaderSize])),
		Payload: b[HeaderSize:],
	}, nil
}

// WindowFrame builds a WINDOW frame granting increment bytes of credit.
func WindowFrame(stream StreamID, increment uint32) Frame {
	return Frame{Kind: KindWindow, Stream: stream, Payload: binary.BigEndian.AppendUint32(nil, increment)}
}

// ParseWindow decodes the payload of a WINDOW frame.
func ParseWindow(payload []byte) (uint32, error) {
	if len(payload) != 4 {
		return 0, ErrBadWindow
	}
	n := binary.BigEndian.Uint32(payload)
	if n == 0 {
		return 0, ErrBadWindow
	}
	return n, nil
}
