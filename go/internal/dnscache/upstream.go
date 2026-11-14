package dnscache

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// Upstream timing and bounds.
const (
	// perTry is how long one upstream server gets (per transport).
	perTry = 1500 * time.Millisecond
	// upstreamBudget bounds one question's whole round of servers.
	upstreamBudget = 4500 * time.Millisecond
	// defaultMaxInflight is how many upstream questions run at once.
	defaultMaxInflight = 200
)

// errBusy: maxInflight upstream questions are running already.
var errBusy = errors.New("dnscache: too many upstream questions in flight")

// errNoUpstream: there is no server to ask.
var errNoUpstream = errors.New("dnscache: no upstream server")

// flight is one upstream question that identical client questions share.
// msg is the answer packed without OPT, or err why there is none.
type flight struct {
	done chan struct{}
	msg  []byte
	err  error
}

// forwarder asks upstream servers. Every question goes out on a fresh UDP
// socket (a random source port) with a random id, and only an answer with
// that id and the same question counts.
type forwarder struct {
	servers func() []string
	stats   *stats
	perTry  time.Duration
	// store keeps a finished answer (the cache's put) before waiters wake.
	store func(k key, msg *dnsmessage.Message)

	sem     chan struct{}
	mu      sync.Mutex
	flights map[key]*flight
}

func newForwarder(servers func() []string, st *stats, maxInflight int, store func(key, *dnsmessage.Message)) *forwarder {
	if maxInflight <= 0 {
		maxInflight = defaultMaxInflight
	}
	return &forwarder{servers: servers, stats: st, perTry: perTry, store: store, sem: make(chan struct{}, maxInflight), flights: map[key]*flight{}}
}

// resolve returns the flight for k, starting one unless an identical
// question is already upstream. base bounds the flight's goroutine: it
// outlives the client that started it, so the answer still reaches the
// cache.
func (f *forwarder) resolve(base context.Context, k key, q dnsmessage.Question) *flight {
	f.mu.Lock()
	if fl, ok := f.flights[k]; ok {
		f.mu.Unlock()
		return fl
	}
	fl := &flight{done: make(chan struct{})}
	select {
	case f.sem <- struct{}{}:
	default:
		f.mu.Unlock()
		fl.err = errBusy
		close(fl.done)
		return fl
	}
	f.flights[k] = fl
	f.mu.Unlock()
	go func() {
		defer func() { <-f.sem }()
		ctx, cancel := context.WithTimeout(base, upstreamBudget)
		m, err := f.exchange(ctx, q, k)
		cancel()
		if err == nil {
			fl.msg, err = m.Pack()
			if err == nil && f.store != nil {
				f.store(k, m)
			}
		}
		fl.err = err
		f.mu.Lock()
		delete(f.flights, k)
		f.mu.Unlock()
		close(fl.done)
	}()
	return fl
}

// exchange asks the servers in order until one answers NOERROR or
// NXDOMAIN. SERVFAIL, REFUSED, a timeout or a refused port moves on to the
// next one.
func (f *forwarder) exchange(ctx context.Context, q dnsmessage.Question, k key) (*dnsmessage.Message, error) {
	servers := f.servers()
	if len(servers) == 0 {
		return nil, errNoUpstream
	}
	var last error
	for _, server := range servers {
		if ctx.Err() != nil {
			break
		}
		f.stats.upstreamQuery()
		m, err := f.ask(ctx, server, q, k)
		if err == nil {
			switch m.Header.RCode {
			case dnsmessage.RCodeSuccess, dnsmessage.RCodeNameError:
				return m, nil
			}
			err = fmt.Errorf("%s answered %s", server, m.Header.RCode)
		}
		f.stats.upstreamFailure()
		last = err
	}
	if last == nil {
		last = ctx.Err()
	}
	return nil, last
}

// ask puts one question to one server: UDP, then TCP when the answer is
// truncated.
func (f *forwarder) ask(ctx context.Context, server string, q dnsmessage.Question, k key) (*dnsmessage.Message, error) {
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	pkt, err := upstreamQuery(id, q, k)
	if err != nil {
		return nil, err
	}
	check := func(b []byte) (*dnsmessage.Message, bool, error) {
		var m dnsmessage.Message
		if err := m.Unpack(b); err != nil || !m.Header.Response || m.Header.ID != id {
			// Not the answer: a stray or forged packet. Keep reading.
			return nil, false, nil
		}
		if !sameQuestion(m.Questions, q) {
			return nil, false, nil
		}
		if stripOPT(&m) {
			return nil, true, fmt.Errorf("%s answered with an extended error", server)
		}
		return &m, true, nil
	}
	addr := withPort(server)
	resp, err := exchangeUDP(ctx, addr, pkt, f.perTry, func(b []byte) (bool, error) {
		m, ok, err := check(b)
		if ok && err == nil && m.Header.Truncated {
			return true, errTruncated
		}
		return ok, err
	})
	if errors.Is(err, errTruncated) {
		resp, err = exchangeTCP(ctx, addr, pkt, f.perTry)
	}
	if err != nil {
		return nil, err
	}
	m, ok, err := check(resp)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s answered another question", server)
	}
	return m, nil
}

// relay sends a message the cache does not interpret (another opcode,
// several questions) to the servers in order with a fresh id and returns
// the first answer with the client's id back in it.
func (f *forwarder) relay(ctx context.Context, raw []byte, udp bool) ([]byte, error) {
	if len(raw) < 12 {
		return nil, errNoHeader
	}
	clientID := binary.BigEndian.Uint16(raw)
	servers := f.servers()
	if len(servers) == 0 {
		return nil, errNoUpstream
	}
	var last error
	for _, server := range servers {
		if ctx.Err() != nil {
			break
		}
		id, err := randomID()
		if err != nil {
			return nil, err
		}
		pkt := append([]byte(nil), raw...)
		binary.BigEndian.PutUint16(pkt, id)
		match := func(b []byte) (bool, error) {
			if len(b) < 12 || binary.BigEndian.Uint16(b) != id || b[2]&0x80 == 0 {
				return false, nil
			}
			if udp && b[2]&0x02 != 0 {
				// Truncated: the client asks again over TCP.
				return true, nil
			}
			if b[2]&0x02 != 0 {
				return true, errTruncated
			}
			return true, nil
		}
		f.stats.upstreamQuery()
		addr := withPort(server)
		resp, err := exchangeUDP(ctx, addr, pkt, f.perTry, match)
		if errors.Is(err, errTruncated) {
			resp, err = exchangeTCP(ctx, addr, pkt, f.perTry)
			if err == nil && (len(resp) < 12 || binary.BigEndian.Uint16(resp) != id) {
				err = fmt.Errorf("%s answered another question", server)
			}
		}
		if err != nil {
			f.stats.upstreamFailure()
			last = err
			continue
		}
		binary.BigEndian.PutUint16(resp, clientID)
		return resp, nil
	}
	if last == nil {
		last = ctx.Err()
	}
	return nil, last
}

var errTruncated = errors.New("dnscache: truncated answer")

// exchangeUDP sends pkt on a fresh connected UDP socket and reads until
// match accepts a packet (ok) or the try's time is up. A connected socket
// only gets packets from addr, and a closed port there fails at once
// (ICMP port unreachable).
func exchangeUDP(ctx context.Context, addr string, pkt []byte, timeout time.Duration, match func([]byte) (ok bool, err error)) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "udp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if _, err := conn.Write(pkt); err != nil {
		return nil, err
	}
	buf := make([]byte, maxMessage)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return nil, err
		}
		ok, err := match(buf[:n])
		if !ok {
			continue
		}
		if err != nil {
			return nil, err
		}
		return append([]byte(nil), buf[:n]...), nil
	}
}

// exchangeTCP sends pkt over a new TCP connection and reads one answer.
func exchangeTCP(ctx context.Context, addr string, pkt []byte, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	if err := writeTCP(conn, pkt); err != nil {
		return nil, err
	}
	return readTCP(conn)
}

// writeTCP and readTCP frame DNS over TCP (a two-byte length first).
func writeTCP(w io.Writer, msg []byte) error {
	if len(msg) > maxMessage {
		return errors.New("dnscache: message too large")
	}
	buf := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(buf, uint16(len(msg)))
	copy(buf[2:], msg)
	_, err := w.Write(buf)
	return err
}

func readTCP(r io.Reader) ([]byte, error) {
	var l [2]byte
	if _, err := io.ReadFull(r, l[:]); err != nil {
		return nil, err
	}
	msg := make([]byte, binary.BigEndian.Uint16(l[:]))
	if _, err := io.ReadFull(r, msg); err != nil {
		return nil, err
	}
	return msg, nil
}

// withPort adds :53 to an address without a port.
func withPort(server string) string {
	if _, _, err := net.SplitHostPort(server); err == nil {
		return server
	}
	return net.JoinHostPort(server, "53")
}

func randomID() (uint16, error) {
	var b [2]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0, err
	}
	return binary.BigEndian.Uint16(b[:]), nil
}
