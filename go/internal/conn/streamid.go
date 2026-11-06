package conn

import (
	"errors"
	"math"
	"sync"
)

// Role is which side of the WebSocket a peer is. It decides stream id
// parity so both sides can open streams without coordinating.
type Role uint8

const (
	// RoleDialer is the agent: odd stream ids.
	RoleDialer Role = iota + 1
	// RoleAcceptor is the panel: even stream ids.
	RoleAcceptor
)

// ErrStreamIDsExhausted means a connection opened about two billion
// streams. The caller reconnects, which starts the numbering over.
var ErrStreamIDsExhausted = errors.New("conn: stream ids exhausted, reconnect")

// StreamIDs hands out the stream ids of one side of a connection. Ids are
// never reused within a connection, so a late frame for a finished stream
// can never be mistaken for a new one.
type StreamIDs struct {
	mu   sync.Mutex
	next uint64
}

// NewStreamIDs returns an allocator for the given side.
func NewStreamIDs(role Role) *StreamIDs {
	first := uint64(2)
	if role == RoleDialer {
		first = 1
	}
	return &StreamIDs{next: first}
}

// Next returns a fresh stream id.
func (s *StreamIDs) Next() (StreamID, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.next > math.MaxUint32 {
		return 0, ErrStreamIDsExhausted
	}
	id := StreamID(s.next)
	s.next += 2
	return id, nil
}

// OpenedBy reports which side allocated id. Stream 0 belongs to neither.
func OpenedBy(id StreamID) (Role, bool) {
	switch {
	case id == ConnectionStream:
		return 0, false
	case id%2 == 1:
		return RoleDialer, true
	default:
		return RoleAcceptor, true
	}
}
