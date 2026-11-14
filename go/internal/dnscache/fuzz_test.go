package dnscache

import (
	"context"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
)

// Client messages are untrusted (any container on the node can send
// them): whatever arrives, the cache neither panics nor answers more than
// the client takes over UDP, and every answer it sends parses.
func FuzzAnswer(f *testing.F) {
	f.Add(query(f, 1, "example.com.", dnsmessage.TypeA, false, false))
	f.Add(query(f, 2, "Example.COM.", dnsmessage.TypeAAAA, true, true))
	f.Add(query(f, 3, "probe-1."+ProbeZone, dnsmessage.TypeA, true, false))
	f.Add([]byte{0, 1, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0})
	f.Add([]byte{})
	s := NewServer(ServerOptions{}) // no upstream: SERVFAIL at once
	defer s.Close()
	f.Fuzz(func(t *testing.T, msg []byte) {
		out := s.Answer(context.Background(), msg, client, true)
		if out == nil {
			return
		}
		var m dnsmessage.Message
		if err := m.Unpack(out); err != nil {
			t.Fatalf("answer does not parse: %v", err)
		}
		limit := plainUDPSize
		if r, err := parseRequest(msg); err == nil && r.edns {
			limit = r.udpSize
		}
		if len(out) > limit {
			t.Fatalf("UDP answer of %d bytes for a client that takes %d", len(out), limit)
		}
	})
}

// Upstream answers are untrusted too: whatever one sends for a question,
// keeping it and answering from it never panics, and what goes out parses.
func FuzzUpstreamAnswer(f *testing.F) {
	ok, _ := (&dnsmessage.Message{Header: dnsmessage.Header{Response: true}, Questions: []dnsmessage.Question{{Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
		Answers: []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 60}, Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 1}}}}}).Pack()
	f.Add(ok)
	f.Add([]byte{0, 0, 0x81, 0x83, 0, 1, 0, 0, 0, 0, 0, 0})
	c := newClock()
	s := NewServer(ServerOptions{Now: c.Now})
	defer s.Close()
	req, err := parseRequest(query(f, 5, "example.com.", dnsmessage.TypeA, false, false))
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, upstream []byte) {
		var m dnsmessage.Message
		if m.Unpack(upstream) != nil {
			return
		}
		stripOPT(&m)
		k := req.key()
		s.store(k, &m)
		e, _, found := s.cache.get(k, c.Now())
		if !found {
			return
		}
		for _, ttl := range []int{-1, staleTTL} {
			out := s.fromEntry(e, req, true, ttl)
			var back dnsmessage.Message
			if err := back.Unpack(out); err != nil {
				t.Fatalf("answer from the cache does not parse: %v", err)
			}
			if len(out) > plainUDPSize {
				t.Fatalf("%d bytes to a client without EDNS", len(out))
			}
		}
	})
}
