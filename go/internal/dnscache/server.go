package dnscache

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"

	"github.com/seylo-dev/app/go/gen/brand"
)

// How long a client waits: for an expired answer while the upstreams have
// not answered (serve-stale), and at most before it gets SERVFAIL, which
// is under the 4 s Docker's embedded DNS waits before it tries the next
// server.
const (
	staleAfter = 1800 * time.Millisecond
	failAfter  = 3 * time.Second
)

// Bounds on what clients can make the cache hold open.
const (
	maxUDPHandlers = 1024
	maxTCPConns    = 64
	tcpIdle        = 10 * time.Second
)

// ProbeZone is the zone the cache answers itself (it never goes upstream):
// the health check's test from inside a container asks for
// probe-<nonce>.<ProbeZone> and gets ProbeAnswer, which proves the
// container reaches the cache whatever the upstreams do.
var ProbeZone = "dnscache." + brand.Slug + ".internal."

// ProbeAnswer is the A record of every name in ProbeZone (TEST-NET-1).
var ProbeAnswer = netip.AddrFrom4([4]byte{192, 0, 2, 53})

// ServerOptions configure a Server.
type ServerOptions struct {
	// Upstreams returns the servers to ask, in order: IP addresses, with
	// ":port" for tests.
	Upstreams func() []string
	// Allowed says whether a source may ask. Nil allows every source
	// (tests); the agent allows Docker bridge subnets and the address
	// itself.
	Allowed func(netip.Addr) bool
	// MaxEntries, MaxBytes and MaxInflight override the bounds (tests).
	MaxEntries, MaxBytes, MaxInflight int
	Logger                            *slog.Logger
	Now                               func() time.Time
}

// Server is the forwarding cache.
type Server struct {
	opts  ServerOptions
	cache *cache
	fwd   *forwarder
	stats *stats

	base   context.Context
	cancel context.CancelFunc

	udpSlots chan struct{}
	tcpSlots chan struct{}

	probeMu sync.Mutex
	probes  map[string]probeHit
}

type probeHit struct {
	src netip.Addr
	at  time.Time
}

// maxProbes bounds the names remembered for the health check.
const maxProbes = 64

// NewServer builds a cache; Serve puts it on sockets, Answer answers one
// message (tests, and both transports).
func NewServer(opts ServerOptions) *Server {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Upstreams == nil {
		opts.Upstreams = func() []string { return nil }
	}
	s := &Server{opts: opts, cache: newCache(opts.MaxEntries, opts.MaxBytes), stats: &stats{now: opts.Now},
		udpSlots: make(chan struct{}, maxUDPHandlers), tcpSlots: make(chan struct{}, maxTCPConns), probes: map[string]probeHit{}}
	// The base context bounds upstream questions, which outlive the client
	// that started them; Close ends it.
	s.base, s.cancel = context.WithCancel(context.Background())
	s.fwd = newForwarder(opts.Upstreams, s.stats, opts.MaxInflight, s.store)
	return s
}

// Close stops upstream questions in flight. Serve's sockets are the
// caller's to close.
func (s *Server) Close() { s.cancel() }

// Counts are the counters since the server was made.
func (s *Server) Counts() Counts { return s.stats.snapshot() }

// Entries is the number of names held.
func (s *Server) Entries() int { return s.cache.len() }

// SawProbe reports whether a question for name (in ProbeZone) reached the
// cache, and from where.
func (s *Server) SawProbe(name string) (netip.Addr, bool) {
	s.probeMu.Lock()
	defer s.probeMu.Unlock()
	hit, ok := s.probes[strings.ToLower(dnsName(name))]
	return hit.src, ok
}

func dnsName(name string) string {
	if !strings.HasSuffix(name, ".") {
		return name + "."
	}
	return name
}

func (s *Server) allowed(src netip.Addr) bool {
	return s.opts.Allowed == nil || s.opts.Allowed(src.Unmap())
}

// Serve answers on udp and tcp until ctx ends or a socket fails. Sources
// that are not allowed get nothing, so the cache is no open resolver.
func (s *Server) Serve(ctx context.Context, udp *net.UDPConn, tcp *net.TCPListener) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 2)
	go func() { errs <- s.serveUDP(ctx, udp) }()
	go func() { errs <- s.serveTCP(ctx, tcp) }()
	err := <-errs
	cancel()
	_ = udp.SetReadDeadline(time.Now())
	_ = tcp.SetDeadline(time.Now())
	<-errs
	if ctx.Err() != nil && errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (s *Server) serveUDP(ctx context.Context, conn *net.UDPConn) error {
	stop := context.AfterFunc(ctx, func() { _ = conn.SetReadDeadline(time.Now()) })
	defer stop()
	buf := make([]byte, maxQuery)
	for {
		n, src, err := conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		select {
		case s.udpSlots <- struct{}{}:
		default:
			// Too many questions open at once: drop, the client retries.
			s.stats.drop()
			continue
		}
		msg := append([]byte(nil), buf[:n]...)
		go func() {
			defer func() { <-s.udpSlots }()
			// Not in the read loop: an unknown source may make the filter
			// list Docker's networks again.
			if !s.allowed(src.Addr()) {
				s.stats.drop()
				return
			}
			if out := s.Answer(ctx, msg, src.Addr(), true); out != nil {
				_, _ = conn.WriteToUDPAddrPort(out, src)
			}
		}()
	}
}

func (s *Server) serveTCP(ctx context.Context, ln *net.TCPListener) error {
	stop := context.AfterFunc(ctx, func() { _ = ln.SetDeadline(time.Now()) })
	defer stop()
	for {
		conn, err := ln.AcceptTCP()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return err
		}
		src := conn.RemoteAddr().(*net.TCPAddr).AddrPort().Addr()
		select {
		case s.tcpSlots <- struct{}{}:
		default:
			s.stats.drop()
			_ = conn.Close()
			continue
		}
		go func() {
			defer func() { <-s.tcpSlots }()
			defer conn.Close()
			if !s.allowed(src) {
				s.stats.drop()
				return
			}
			stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
			defer stop()
			for {
				_ = conn.SetDeadline(time.Now().Add(tcpIdle))
				msg, err := readTCP(conn)
				if err != nil {
					return
				}
				out := s.Answer(ctx, msg, src, false)
				if out == nil {
					return
				}
				if err := writeTCP(conn, out); err != nil {
					return
				}
			}
		}()
	}
}

// Answer answers one client message from src (udp: the reply must fit the
// client's UDP size). Nil means no answer at all: not a DNS question, or
// ctx ended.
func (s *Server) Answer(ctx context.Context, msg []byte, src netip.Addr, udp bool) []byte {
	r, err := parseRequest(msg)
	if errors.Is(err, errNoHeader) || r.header.Response {
		return nil
	}
	s.stats.query()
	if err != nil {
		return failure(r, dnsmessage.RCodeFormatError)
	}
	if !r.cacheable() {
		ctx, cancel := context.WithTimeout(ctx, failAfter)
		defer cancel()
		out, err := s.fwd.relay(ctx, msg, udp)
		if err != nil {
			return failure(r, dnsmessage.RCodeServerFailure)
		}
		return out
	}
	q := r.questions[0]
	if inZone(q.Name.String(), ProbeZone) {
		return s.probe(r, src, udp)
	}
	k := r.key()
	stale, fresh, haveStale := s.cache.get(k, s.opts.Now())
	if haveStale && fresh {
		s.stats.hit()
		return s.fromEntry(stale, r, udp, -1)
	}
	fl := s.fwd.resolve(s.base, k, q)
	var staleC <-chan time.Time
	if haveStale {
		t := time.NewTimer(staleAfter)
		defer t.Stop()
		staleC = t.C
	}
	fail := time.NewTimer(failAfter)
	defer fail.Stop()
	select {
	case <-fl.done:
		if fl.err == nil {
			return s.fromPacked(fl.msg, r, udp)
		}
		if haveStale {
			s.stats.staleHit()
			return s.fromEntry(stale, r, udp, staleTTL)
		}
		return failure(r, dnsmessage.RCodeServerFailure)
	case <-staleC:
		s.stats.staleHit()
		return s.fromEntry(stale, r, udp, staleTTL)
	case <-fail.C:
		return failure(r, dnsmessage.RCodeServerFailure)
	case <-ctx.Done():
		return nil
	}
}

// store keeps an upstream answer for as long as lifetime allows.
func (s *Server) store(k key, m *dnsmessage.Message) {
	ttl, ok := lifetime(m)
	if !ok {
		return
	}
	stored := *m
	stored.Header.ID = 0
	packed, err := stored.Pack()
	if err != nil {
		return
	}
	now := s.opts.Now()
	s.cache.put(entry{key: k, msg: packed, stored: now, expires: now.Add(ttl)})
}

// fromEntry answers from a cached message: TTLs counted down by its age,
// or all set to ttl (>= 0) for a stale answer.
func (s *Server) fromEntry(e entry, r request, udp bool, ttl int) []byte {
	var m dnsmessage.Message
	if err := m.Unpack(e.msg); err != nil {
		return failure(r, dnsmessage.RCodeServerFailure)
	}
	setTTLs(&m, s.opts.Now().Sub(e.stored), ttl)
	out, err := reply(m, r, udp)
	if err != nil {
		return failure(r, dnsmessage.RCodeServerFailure)
	}
	return out
}

func (s *Server) fromPacked(packed []byte, r request, udp bool) []byte {
	return s.fromEntry(entry{msg: packed, stored: s.opts.Now()}, r, udp, -1)
}

// probe answers a name in ProbeZone: ProbeAnswer for A, no data for the
// rest, never upstream; it remembers who asked.
func (s *Server) probe(r request, src netip.Addr, udp bool) []byte {
	q := r.questions[0]
	s.probeMu.Lock()
	if len(s.probes) >= maxProbes {
		var oldest string
		for name, hit := range s.probes {
			if oldest == "" || hit.at.Before(s.probes[oldest].at) {
				oldest = name
			}
		}
		delete(s.probes, oldest)
	}
	s.probes[strings.ToLower(q.Name.String())] = probeHit{src: src.Unmap(), at: s.opts.Now()}
	s.probeMu.Unlock()
	m := dnsmessage.Message{Header: dnsmessage.Header{Authoritative: true}}
	if q.Type == dnsmessage.TypeA && q.Class == dnsmessage.ClassINET {
		m.Answers = []dnsmessage.Resource{{
			Header: dnsmessage.ResourceHeader{Name: q.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET},
			Body:   &dnsmessage.AResource{A: ProbeAnswer.As4()},
		}}
	}
	out, err := reply(m, r, udp)
	if err != nil {
		return failure(r, dnsmessage.RCodeServerFailure)
	}
	return out
}

// inZone: name is zone or below it (no case).
func inZone(name, zone string) bool {
	name, zone = strings.ToLower(dnsName(name)), strings.ToLower(zone)
	return name == zone || strings.HasSuffix(name, "."+zone)
}
