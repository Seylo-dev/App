package dnscache

import (
	"context"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// fakeUpstream is a DNS server on 127.0.0.1 (UDP and TCP on one port)
// whose answers a test decides.
type fakeUpstream struct {
	t       *testing.T
	addr    string
	udp     *net.UDPConn
	tcp     *net.TCPListener
	queries atomic.Int32
	tcpHits atomic.Int32

	mu sync.Mutex
	// answer builds the answer to q; nil drops the question.
	answer func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message
	delay  time.Duration
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	port := udp.LocalAddr().(*net.UDPAddr).Port
	tcp, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
	if err != nil {
		_ = udp.Close()
		t.Skipf("no TCP port %d next to the UDP one: %v", port, err)
	}
	f := &fakeUpstream{t: t, addr: udp.LocalAddr().String(), udp: udp, tcp: tcp, answer: answerA(netip.MustParseAddr("192.0.2.10"), 300)}
	t.Cleanup(func() { _ = udp.Close(); _ = tcp.Close() })
	go f.serveUDP()
	go f.serveTCP()
	return f
}

func (f *fakeUpstream) set(answer func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message) {
	f.mu.Lock()
	f.answer = answer
	f.mu.Unlock()
}

func (f *fakeUpstream) setDelay(d time.Duration) {
	f.mu.Lock()
	f.delay = d
	f.mu.Unlock()
}

func (f *fakeUpstream) respond(b []byte, overTCP bool) []byte {
	var q dnsmessage.Message
	if err := q.Unpack(b); err != nil {
		return nil
	}
	f.queries.Add(1)
	f.mu.Lock()
	answer, delay := f.answer, f.delay
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	m := answer(q, overTCP)
	if m == nil {
		return nil
	}
	m.Header.ID = q.Header.ID
	m.Header.Response = true
	if m.Questions == nil {
		m.Questions = q.Questions
	}
	out, err := m.Pack()
	if err != nil {
		f.t.Errorf("fake upstream: %v", err)
		return nil
	}
	return out
}

func (f *fakeUpstream) serveUDP() {
	buf := make([]byte, maxMessage)
	for {
		n, src, err := f.udp.ReadFromUDPAddrPort(buf)
		if err != nil {
			return
		}
		msg := append([]byte(nil), buf[:n]...)
		go func() {
			if out := f.respond(msg, false); out != nil {
				_, _ = f.udp.WriteToUDPAddrPort(out, src)
			}
		}()
	}
}

func (f *fakeUpstream) serveTCP() {
	for {
		c, err := f.tcp.Accept()
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			msg, err := readTCP(c)
			if err != nil {
				return
			}
			f.tcpHits.Add(1)
			if out := f.respond(msg, true); out != nil {
				_ = writeTCP(c, out)
			}
		}()
	}
}

// answerA answers every A question with addr and ttl, other types with
// no data.
func answerA(addr netip.Addr, ttl uint32) func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message {
	return func(q dnsmessage.Message, _ bool) *dnsmessage.Message {
		m := &dnsmessage.Message{Header: dnsmessage.Header{RecursionAvailable: true}}
		if len(q.Questions) == 1 && q.Questions[0].Type == dnsmessage.TypeA {
			m.Answers = []dnsmessage.Resource{{
				Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: ttl},
				Body:   &dnsmessage.AResource{A: addr.As4()},
			}}
		}
		return m
	}
}

// rcodeOnly answers every question with rcode and no records.
func rcodeOnly(rcode dnsmessage.RCode) func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message {
	return func(dnsmessage.Message, bool) *dnsmessage.Message {
		return &dnsmessage.Message{Header: dnsmessage.Header{RCode: rcode}}
	}
}

// clock is a settable time for the cache.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// query packs a question as a client would send it.
func query(t testing.TB, id uint16, name string, qtype dnsmessage.Type, edns bool, do bool) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, RecursionDesired: true})
	if err := b.StartQuestions(); err != nil {
		t.Fatal(err)
	}
	if err := b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: qtype, Class: dnsmessage.ClassINET}); err != nil {
		t.Fatal(err)
	}
	if edns {
		if err := b.StartAdditionals(); err != nil {
			t.Fatal(err)
		}
		var rh dnsmessage.ResourceHeader
		if err := rh.SetEDNS0(1232, dnsmessage.RCodeSuccess, do); err != nil {
			t.Fatal(err)
		}
		if err := b.OPTResource(rh, dnsmessage.OPTResource{}); err != nil {
			t.Fatal(err)
		}
	}
	out, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func unpack(t testing.TB, b []byte) dnsmessage.Message {
	t.Helper()
	var m dnsmessage.Message
	if err := m.Unpack(b); err != nil {
		t.Fatalf("unpacking the answer: %v", err)
	}
	return m
}

func newTestServer(c *clock, upstreams ...string) *Server {
	return NewServer(ServerOptions{Upstreams: func() []string { return upstreams }, Now: c.Now})
}

var client = netip.MustParseAddr("172.18.0.5")

func ask(t testing.TB, s *Server, msg []byte) dnsmessage.Message {
	t.Helper()
	out := s.Answer(context.Background(), msg, client, true)
	if out == nil {
		t.Fatal("no answer")
	}
	return unpack(t, out)
}
