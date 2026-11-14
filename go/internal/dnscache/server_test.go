package dnscache

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func firstA(t *testing.T, m dnsmessage.Message) (netip.Addr, uint32) {
	t.Helper()
	for _, rr := range m.Answers {
		if a, ok := rr.Body.(*dnsmessage.AResource); ok {
			return netip.AddrFrom4(a.A), rr.Header.TTL
		}
	}
	t.Fatalf("no A record in %+v", m)
	return netip.Addr{}, 0
}

// The second question for a name within its TTL comes from the cache,
// with the TTL counted down, and never reaches the upstream.
func TestRepeatedNameGoesUpstreamOnce(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	s := newTestServer(c, up.addr)
	defer s.Close()

	m := ask(t, s, query(t, 1, "api.example.com.", dnsmessage.TypeA, false, false))
	if addr, ttl := firstA(t, m); addr.String() != "192.0.2.10" || ttl != 300 {
		t.Fatalf("first answer %s ttl %d", addr, ttl)
	}
	c.add(100 * time.Second)
	m = ask(t, s, query(t, 2, "API.Example.com.", dnsmessage.TypeA, false, false))
	if m.Header.ID != 2 {
		t.Fatalf("id %d, want the client's", m.Header.ID)
	}
	if got := m.Questions[0].Name.String(); got != "API.Example.com." {
		t.Fatalf("question %q, want the client's own spelling", got)
	}
	if _, ttl := firstA(t, m); ttl != 200 {
		t.Fatalf("ttl %d, want 200 (300 counted down by 100 s)", ttl)
	}
	if n := up.queries.Load(); n != 1 {
		t.Fatalf("upstream got %d questions, want 1", n)
	}
	cnt := s.Counts()
	if cnt.Queries != 2 || cnt.Hits != 1 || cnt.Upstream != 1 {
		t.Fatalf("counts %+v", cnt)
	}
	// Past the TTL it asks again.
	c.add(201 * time.Second)
	ask(t, s, query(t, 3, "api.example.com.", dnsmessage.TypeA, false, false))
	if n := up.queries.Load(); n != 2 {
		t.Fatalf("after the TTL the upstream got %d questions, want 2", n)
	}
}

// Positive answers are kept for at most an hour, whatever their TTL.
func TestPositiveTTLCappedAtAnHour(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.set(answerA(netip.MustParseAddr("192.0.2.10"), 86400))
	s := newTestServer(c, up.addr)
	defer s.Close()
	ask(t, s, query(t, 1, "long.example.com.", dnsmessage.TypeA, false, false))
	c.add(time.Hour + time.Second)
	ask(t, s, query(t, 2, "long.example.com.", dnsmessage.TypeA, false, false))
	if n := up.queries.Load(); n != 2 {
		t.Fatalf("upstream got %d questions, want 2 (an hour at most)", n)
	}
}

func soaAnswer(rcode dnsmessage.RCode, soaTTL, minimum uint32) func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message {
	return func(q dnsmessage.Message, _ bool) *dnsmessage.Message {
		return &dnsmessage.Message{
			Header: dnsmessage.Header{RCode: rcode},
			Authorities: []dnsmessage.Resource{{
				Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.TypeSOA, Class: dnsmessage.ClassINET, TTL: soaTTL},
				Body: &dnsmessage.SOAResource{NS: dnsmessage.MustNewName("ns.example.com."), MBox: dnsmessage.MustNewName("hostmaster.example.com."),
					Serial: 1, Refresh: 3600, Retry: 600, Expire: 86400, MinTTL: minimum},
			}},
		}
	}
}

// NXDOMAIN is kept for min(SOA TTL, SOA minimum), at most 30 s; without an
// SOA for 5 s.
func TestNegativeCaching(t *testing.T) {
	for _, tc := range []struct {
		name   string
		answer func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message
		keep   time.Duration
	}{
		{"soa minimum lower", soaAnswer(dnsmessage.RCodeNameError, 3600, 10), 10 * time.Second},
		{"soa ttl lower", soaAnswer(dnsmessage.RCodeNameError, 7, 900), 7 * time.Second},
		{"capped at 30 s", soaAnswer(dnsmessage.RCodeNameError, 3600, 3600), 30 * time.Second},
		{"nodata", soaAnswer(dnsmessage.RCodeSuccess, 20, 20), 20 * time.Second},
		{"no soa", rcodeOnly(dnsmessage.RCodeNameError), 5 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newClock()
			up := newFakeUpstream(t)
			up.set(tc.answer)
			s := newTestServer(c, up.addr)
			defer s.Close()
			first := ask(t, s, query(t, 1, "missing.example.com.", dnsmessage.TypeA, false, false))
			c.add(tc.keep - time.Second)
			second := ask(t, s, query(t, 2, "missing.example.com.", dnsmessage.TypeA, false, false))
			if second.Header.RCode != first.Header.RCode {
				t.Fatalf("rcode %s, want %s", second.Header.RCode, first.Header.RCode)
			}
			if n := up.queries.Load(); n != 1 {
				t.Fatalf("within %s the upstream got %d questions, want 1", tc.keep, n)
			}
			c.add(2 * time.Second)
			ask(t, s, query(t, 3, "missing.example.com.", dnsmessage.TypeA, false, false))
			if n := up.queries.Load(); n != 2 {
				t.Fatalf("after %s the upstream got %d questions, want 2", tc.keep, n)
			}
		})
	}
}

// SERVFAIL and REFUSED are never kept, and the next server is asked.
func TestServfailMovesOnAndIsNotCached(t *testing.T) {
	c := newClock()
	bad := newFakeUpstream(t)
	bad.set(rcodeOnly(dnsmessage.RCodeServerFailure))
	good := newFakeUpstream(t)
	s := newTestServer(c, bad.addr, good.addr)
	defer s.Close()
	m := ask(t, s, query(t, 1, "a.example.com.", dnsmessage.TypeA, false, false))
	if addr, _ := firstA(t, m); addr.String() != "192.0.2.10" {
		t.Fatalf("answer %s", addr)
	}
	if bad.queries.Load() != 1 || good.queries.Load() != 1 {
		t.Fatalf("bad %d good %d", bad.queries.Load(), good.queries.Load())
	}
	if s.Counts().UpstreamFailures != 1 {
		t.Fatalf("failures %d", s.Counts().UpstreamFailures)
	}

	// Only SERVFAIL: the client gets SERVFAIL, and the next question goes
	// upstream again.
	only := newTestServer(c, bad.addr)
	defer only.Close()
	for i := range 2 {
		if m := ask(t, only, query(t, uint16(10+i), "b.example.com.", dnsmessage.TypeA, false, false)); m.Header.RCode != dnsmessage.RCodeServerFailure {
			t.Fatalf("rcode %s", m.Header.RCode)
		}
	}
	if n := bad.queries.Load(); n != 3 {
		t.Fatalf("bad got %d questions, want 3 (SERVFAIL is not cached)", n)
	}
}

// Identical questions at the same time share one upstream question: what
// flattens a container retrying one name in a loop.
func TestConcurrentQuestionsShareOneUpstream(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.setDelay(200 * time.Millisecond)
	s := newTestServer(c, up.addr)
	defer s.Close()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m := ask(t, s, query(t, uint16(i), "burst.example.com.", dnsmessage.TypeA, false, false))
			if m.Header.ID != uint16(i) || len(m.Answers) != 1 {
				t.Errorf("answer %d: %+v", i, m.Header)
			}
		}()
	}
	wg.Wait()
	if n := up.queries.Load(); n != 1 {
		t.Fatalf("upstream got %d questions, want 1", n)
	}
}

// With every upstream down, an expired answer up to an hour old is served
// with TTL 30; older or missing ones get SERVFAIL, within 3 s.
func TestServeStale(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.set(answerA(netip.MustParseAddr("192.0.2.10"), 60))
	s := newTestServer(c, up.addr)
	defer s.Close()
	ask(t, s, query(t, 1, "stale.example.com.", dnsmessage.TypeA, false, false))

	up.set(rcodeOnly(dnsmessage.RCodeServerFailure))
	c.add(30 * time.Minute)
	m := ask(t, s, query(t, 2, "stale.example.com.", dnsmessage.TypeA, false, false))
	if addr, ttl := firstA(t, m); addr.String() != "192.0.2.10" || ttl != staleTTL {
		t.Fatalf("stale answer %s ttl %d", addr, ttl)
	}
	if s.Counts().Stale != 1 {
		t.Fatalf("stale count %d", s.Counts().Stale)
	}

	c.add(time.Hour)
	if m := ask(t, s, query(t, 3, "stale.example.com.", dnsmessage.TypeA, false, false)); m.Header.RCode != dnsmessage.RCodeServerFailure {
		t.Fatalf("over an hour stale: rcode %s, want SERVFAIL", m.Header.RCode)
	}
}

// An upstream that does not answer: an expired entry goes out after
// 1.8 s, and without one SERVFAIL comes within 3 s (before Docker's 4 s).
func TestSlowUpstreamTimes(t *testing.T) {
	if testing.Short() {
		t.Skip("waits seconds")
	}
	c := newClock()
	up := newFakeUpstream(t)
	up.set(answerA(netip.MustParseAddr("192.0.2.10"), 60))
	// Two servers: one silent server alone fails after its 1.5 s try,
	// and a failed round serves the stale answer at once.
	other := newFakeUpstream(t)
	s := newTestServer(c, up.addr, other.addr)
	defer s.Close()
	ask(t, s, query(t, 1, "slow.example.com.", dnsmessage.TypeA, false, false))
	silent := func(dnsmessage.Message, bool) *dnsmessage.Message { return nil }
	up.set(silent)
	other.set(silent)
	c.add(2 * time.Minute)

	start := time.Now()
	m := ask(t, s, query(t, 2, "slow.example.com.", dnsmessage.TypeA, false, false))
	if took := time.Since(start); took < staleAfter || took > staleAfter+2*time.Second {
		t.Fatalf("stale answer after %s, want about %s", took, staleAfter)
	}
	if _, ttl := firstA(t, m); ttl != staleTTL {
		t.Fatalf("ttl %d", ttl)
	}

	start = time.Now()
	m = ask(t, s, query(t, 3, "never.example.com.", dnsmessage.TypeA, false, false))
	if took := time.Since(start); m.Header.RCode != dnsmessage.RCodeServerFailure || took > failAfter+2*time.Second {
		t.Fatalf("rcode %s after %s", m.Header.RCode, took)
	}
}

// A closed port upstream fails at once and the next server answers.
func TestClosedPortMovesOnFast(t *testing.T) {
	c := newClock()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := pc.LocalAddr().String()
	_ = pc.Close()
	good := newFakeUpstream(t)
	s := newTestServer(c, closed, good.addr)
	defer s.Close()
	start := time.Now()
	m := ask(t, s, query(t, 1, "fast.example.com.", dnsmessage.TypeA, false, false))
	if len(m.Answers) != 1 {
		t.Fatalf("answer %+v", m)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("took %s past a closed port", took)
	}
}

// A truncated upstream answer is asked again over TCP; a client without
// EDNS gets at most 512 bytes over UDP, else an empty answer with TC set.
func TestTruncation(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	big := func(q dnsmessage.Message, overTCP bool) *dnsmessage.Message {
		if !overTCP {
			return &dnsmessage.Message{Header: dnsmessage.Header{Truncated: true}}
		}
		m := &dnsmessage.Message{}
		for i := range 40 {
			m.Answers = append(m.Answers, dnsmessage.Resource{
				Header: dnsmessage.ResourceHeader{Name: q.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 300},
				Body:   &dnsmessage.AResource{A: [4]byte{192, 0, 2, byte(i)}},
			})
		}
		return m
	}
	up.set(big)
	s := newTestServer(c, up.addr)
	defer s.Close()

	plain := ask(t, s, query(t, 1, "a-rather-long-name-for-many-records.example.com.", dnsmessage.TypeA, false, false))
	if !plain.Header.Truncated || len(plain.Answers) != 0 {
		t.Fatalf("plain UDP: TC %v answers %d", plain.Header.Truncated, len(plain.Answers))
	}
	if up.tcpHits.Load() != 1 {
		t.Fatalf("tcp hits %d", up.tcpHits.Load())
	}
	// The same over TCP comes from the cache, whole.
	out := s.Answer(context.Background(), query(t, 2, "a-rather-long-name-for-many-records.example.com.", dnsmessage.TypeA, false, false), client, false)
	if m := unpack(t, out); m.Header.Truncated || len(m.Answers) != 40 {
		t.Fatalf("TCP: TC %v answers %d", m.Header.Truncated, len(m.Answers))
	}
	// EDNS with 1232 bytes takes it over UDP.
	m := ask(t, s, query(t, 3, "a-rather-long-name-for-many-records.example.com.", dnsmessage.TypeA, true, false))
	if m.Header.Truncated || len(m.Answers) != 40 {
		t.Fatalf("EDNS UDP: TC %v answers %d", m.Header.Truncated, len(m.Answers))
	}
	if n := up.queries.Load(); n != 2 {
		t.Fatalf("upstream got %d questions (UDP then TCP), want 2", n)
	}
}

// The DO bit is part of the key: an answer for a client that wants DNSSEC
// records is not the one for a client that does not.
func TestDOBitIsPartOfTheKey(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	s := newTestServer(c, up.addr)
	defer s.Close()
	ask(t, s, query(t, 1, "sec.example.com.", dnsmessage.TypeA, true, false))
	m := ask(t, s, query(t, 2, "sec.example.com.", dnsmessage.TypeA, true, true))
	if n := up.queries.Load(); n != 2 {
		t.Fatalf("upstream got %d questions, want 2", n)
	}
	// The client's EDNS is answered with the cache's own OPT record.
	var opt bool
	for _, rr := range m.Additionals {
		if rr.Header.Type == dnsmessage.TypeOPT {
			opt = rr.Header.DNSSECAllowed()
		}
	}
	if !opt {
		t.Fatal("no OPT record with DO for an EDNS client")
	}
}

// An answer to another question (a forged or stray packet) is ignored.
func TestWrongQuestionIgnored(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.set(func(q dnsmessage.Message, _ bool) *dnsmessage.Message {
		m := answerA(netip.MustParseAddr("192.0.2.66"), 300)(q, false)
		m.Questions = []dnsmessage.Question{{Name: dnsmessage.MustNewName("evil.example.net."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}}
		return m
	})
	s := newTestServer(c, up.addr)
	defer s.Close()
	s.fwd.perTry = 200 * time.Millisecond
	m := ask(t, s, query(t, 1, "victim.example.com.", dnsmessage.TypeA, false, false))
	if m.Header.RCode != dnsmessage.RCodeServerFailure || len(m.Answers) != 0 {
		t.Fatalf("got %s with %d answers for a mismatched question", m.Header.RCode, len(m.Answers))
	}
}

// Names in ProbeZone are answered by the cache itself and remembered.
func TestProbeZoneAnsweredLocally(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	s := newTestServer(c, up.addr)
	defer s.Close()
	name := "probe-0011.dnscache.seylo.internal."
	if ProbeZone != "dnscache.seylo.internal." {
		name = "probe-0011." + ProbeZone
	}
	m := ask(t, s, query(t, 1, name, dnsmessage.TypeA, false, false))
	if addr, _ := firstA(t, m); addr != ProbeAnswer {
		t.Fatalf("probe answer %s", addr)
	}
	if m := ask(t, s, query(t, 2, name, dnsmessage.TypeAAAA, false, false)); m.Header.RCode != dnsmessage.RCodeSuccess || len(m.Answers) != 0 {
		t.Fatalf("AAAA: %s with %d answers", m.Header.RCode, len(m.Answers))
	}
	if src, ok := s.SawProbe(strings.TrimSuffix(name, ".")); !ok || src != client {
		t.Fatalf("SawProbe = %s %v", src, ok)
	}
	if up.queries.Load() != 0 {
		t.Fatal("a probe name went upstream")
	}
}

// Another opcode is relayed as it is, with the client's id back.
func TestOtherOpcodesRelayed(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.set(rcodeOnly(dnsmessage.RCodeNotImplemented))
	s := newTestServer(c, up.addr)
	defer s.Close()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: 77, OpCode: 4}) // NOTIFY
	_ = b.StartQuestions()
	_ = b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName("example.com."), Type: dnsmessage.TypeSOA, Class: dnsmessage.ClassINET})
	msg, _ := b.Finish()
	m := ask(t, s, msg)
	if m.Header.ID != 77 || m.Header.RCode != dnsmessage.RCodeNotImplemented {
		t.Fatalf("relayed: id %d rcode %s", m.Header.ID, m.Header.RCode)
	}
}

// Garbage gets no answer; a header with a broken body gets FORMERR.
func TestMalformedQuestions(t *testing.T) {
	s := newTestServer(newClock())
	defer s.Close()
	if out := s.Answer(context.Background(), []byte{1, 2, 3}, client, true); out != nil {
		t.Fatal("answered garbage")
	}
	msg := query(t, 9, "x.example.com.", dnsmessage.TypeA, false, false)
	msg = msg[:len(msg)-3]
	if m := ask(t, s, msg); m.Header.RCode != dnsmessage.RCodeFormatError || m.Header.ID != 9 {
		t.Fatalf("broken body: id %d rcode %s", m.Header.ID, m.Header.RCode)
	}
	// A response is never answered (no loops between resolvers).
	resp := query(t, 10, "x.example.com.", dnsmessage.TypeA, false, false)
	resp[2] |= 0x80
	if out := s.Answer(context.Background(), resp, client, true); out != nil {
		t.Fatal("answered a response")
	}
}

// Past MaxInflight upstream questions a new name gets SERVFAIL at once
// (the client moves on to its fallback) instead of piling up.
func TestInflightBound(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	up.setDelay(3 * time.Second)
	s := NewServer(ServerOptions{Upstreams: func() []string { return []string{up.addr} }, Now: c.Now, MaxInflight: 1})
	defer s.Close()
	go s.Answer(context.Background(), query(t, 1, "first.example.com.", dnsmessage.TypeA, false, false), client, true)
	for up.queries.Load() == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	m := ask(t, s, query(t, 2, "second.example.com.", dnsmessage.TypeA, false, false))
	if m.Header.RCode != dnsmessage.RCodeServerFailure || time.Since(start) > time.Second {
		t.Fatalf("rcode %s after %s", m.Header.RCode, time.Since(start))
	}
}

// The LRU keeps at most MaxEntries names.
func TestCacheBounds(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	s := NewServer(ServerOptions{Upstreams: func() []string { return []string{up.addr} }, Now: c.Now, MaxEntries: 3})
	defer s.Close()
	for _, n := range []string{"a", "b", "c", "d"} {
		ask(t, s, query(t, 1, n+".example.com.", dnsmessage.TypeA, false, false))
	}
	if s.Entries() != 3 {
		t.Fatalf("entries %d", s.Entries())
	}
	// "a" went first.
	ask(t, s, query(t, 2, "a.example.com.", dnsmessage.TypeA, false, false))
	if n := up.queries.Load(); n != 5 {
		t.Fatalf("upstream got %d, want 5 (a was evicted)", n)
	}

	cc := newCache(100, 600)
	for i := range 10 {
		cc.put(entry{key: key{name: strings.Repeat("x", i+1)}, msg: make([]byte, 100)})
	}
	if cc.usage() > 600 {
		t.Fatalf("bytes %d over 600", cc.usage())
	}
}

// Over sockets: an allowed source gets answers over UDP and TCP, any
// other gets nothing.
func TestServeFiltersSources(t *testing.T) {
	c := newClock()
	up := newFakeUpstream(t)
	var mu sync.Mutex
	allow := true
	s := NewServer(ServerOptions{Upstreams: func() []string { return []string{up.addr} }, Now: c.Now, Allowed: func(netip.Addr) bool {
		mu.Lock()
		defer mu.Unlock()
		return allow
	}})
	defer s.Close()
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	tcp, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: udp.LocalAddr().(*net.UDPAddr).Port})
	if err != nil {
		t.Skip(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, udp, tcp) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Serve: %v", err)
		}
	}()
	addr := udp.LocalAddr().String()
	pkt := query(t, 5, "sock.example.com.", dnsmessage.TypeA, false, false)
	if _, err := exchangeUDP(context.Background(), addr, pkt, time.Second, func(b []byte) (bool, error) { return true, nil }); err != nil {
		t.Fatalf("UDP: %v", err)
	}
	if out, err := exchangeTCP(context.Background(), addr, pkt, time.Second); err != nil || len(unpack(t, out).Answers) != 1 {
		t.Fatalf("TCP: %v", err)
	}
	mu.Lock()
	allow = false
	mu.Unlock()
	if _, err := exchangeUDP(context.Background(), addr, pkt, 300*time.Millisecond, func(b []byte) (bool, error) { return true, nil }); err == nil {
		t.Fatal("a source that is not allowed got an answer")
	}
	if s.Counts().Dropped == 0 {
		t.Fatal("no drop counted")
	}
}
