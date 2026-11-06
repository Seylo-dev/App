package rpc

import "sync/atomic"

// SessionStats are counters of one session, for the local status API and
// logs.
type SessionStats struct {
	// In flight now.
	IncomingCalls   int64
	IncomingStreams int64
	OutgoingCalls   int64
	OutgoingStreams int64
	// Since the session started.
	IncomingTotal int64
	OutgoingTotal int64
	EventsSent    int64
	EventsDropped int64
	HandlerPanics int64
}

type sessionCounters struct {
	inUnary, inStreams, outUnary, outStreams atomic.Int64
	inTotal, outTotal                        atomic.Int64
	eventsSent, eventsDropped, panics        atomic.Int64
}

// Stats returns the session's counters.
func (s *Session) Stats() SessionStats {
	c := &s.stats
	return SessionStats{
		IncomingCalls:   c.inUnary.Load(),
		IncomingStreams: c.inStreams.Load(),
		OutgoingCalls:   c.outUnary.Load(),
		OutgoingStreams: c.outStreams.Load(),
		IncomingTotal:   c.inTotal.Load(),
		OutgoingTotal:   c.outTotal.Load(),
		EventsSent:      c.eventsSent.Load(),
		EventsDropped:   c.eventsDropped.Load(),
		HandlerPanics:   c.panics.Load(),
	}
}
