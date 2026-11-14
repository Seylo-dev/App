package dnscache

import (
	"errors"
	"strings"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// Sizes the cache works with.
const (
	// maxQuery is the largest client question read; a real one is far
	// smaller (one name, maybe an OPT record).
	maxQuery = 4096
	// ednsSize is the UDP size the cache offers clients and asks upstreams
	// for (the DNS flag day 2020 value: no IP fragmentation).
	ednsSize = 1232
	// plainUDPSize is what a client without EDNS takes over UDP.
	plainUDPSize = 512
	// maxMessage is the largest DNS message (TCP's two-byte length).
	maxMessage = 65535
)

// errNoHeader: not even a DNS header, so no answer can be addressed.
var errNoHeader = errors.New("dnscache: not a DNS message")

// request is a client's question as the cache reads it.
type request struct {
	header    dnsmessage.Header
	questions []dnsmessage.Question
	// edns: the client sent an OPT record; udpSize is what it takes over
	// UDP (512 without EDNS), do its DNSSEC OK bit.
	edns    bool
	udpSize int
	do      bool
}

// parseRequest reads a client's message. A header that parses with a body
// that does not is returned with the error, so the client gets FORMERR.
func parseRequest(b []byte) (request, error) {
	var p dnsmessage.Parser
	h, err := p.Start(b)
	if err != nil {
		return request{}, errNoHeader
	}
	r := request{header: h, udpSize: plainUDPSize}
	if r.questions, err = p.AllQuestions(); err != nil {
		return r, err
	}
	if err := p.SkipAllAnswers(); err != nil {
		return r, err
	}
	if err := p.SkipAllAuthorities(); err != nil {
		return r, err
	}
	for {
		rh, err := p.AdditionalHeader()
		if errors.Is(err, dnsmessage.ErrSectionDone) {
			break
		}
		if err != nil {
			return r, err
		}
		if rh.Type == dnsmessage.TypeOPT {
			r.edns = true
			r.udpSize = min(max(int(rh.Class), plainUDPSize), maxMessage)
			r.do = rh.DNSSECAllowed()
		}
		if err := p.SkipAdditional(); err != nil {
			return r, err
		}
	}
	return r, nil
}

// cacheable: a standard query with one question, the only kind the cache
// keeps answers for. Anything else goes upstream as it is.
func (r request) cacheable() bool {
	return r.header.OpCode == 0 && len(r.questions) == 1
}

// key identifies a cached answer: lowercased name, type, class and the
// DO and CD bits (they change what an upstream answers).
type key struct {
	name  string
	qtype dnsmessage.Type
	class dnsmessage.Class
	do    bool
	cd    bool
}

func (r request) key() key {
	q := r.questions[0]
	return key{name: strings.ToLower(q.Name.String()), qtype: q.Type, class: q.Class, do: r.do, cd: r.header.CheckingDisabled}
}

// size is about what the key costs in memory.
func (k key) size() int { return len(k.name) + 16 }

// upstreamQuery is the question the cache sends for k: recursion desired,
// CD as the client set it, and an OPT record offering ednsSize with the
// client's DO bit. Client OPT options (cookies, client subnet) are not
// passed on: the answer is shared by every client.
func upstreamQuery(id uint16, q dnsmessage.Question, k key) ([]byte, error) {
	b := dnsmessage.NewBuilder(make([]byte, 0, 128), dnsmessage.Header{ID: id, RecursionDesired: true, CheckingDisabled: k.cd})
	b.EnableCompression()
	if err := b.StartQuestions(); err != nil {
		return nil, err
	}
	if err := b.Question(q); err != nil {
		return nil, err
	}
	if err := b.StartAdditionals(); err != nil {
		return nil, err
	}
	var rh dnsmessage.ResourceHeader
	if err := rh.SetEDNS0(ednsSize, dnsmessage.RCodeSuccess, k.do); err != nil {
		return nil, err
	}
	if err := b.OPTResource(rh, dnsmessage.OPTResource{}); err != nil {
		return nil, err
	}
	return b.Finish()
}

// stripOPT removes OPT records (an upstream's or a client's) from the
// additional section. It reports the extended RCODE bits an OPT carried.
func stripOPT(m *dnsmessage.Message) (extended bool) {
	kept := m.Additionals[:0]
	for _, rr := range m.Additionals {
		if rr.Header.Type == dnsmessage.TypeOPT {
			if rr.Header.ExtendedRCode(0) != 0 {
				extended = true
			}
			continue
		}
		kept = append(kept, rr)
	}
	m.Additionals = kept
	return extended
}

// sameQuestion: an upstream answer is for the question that was asked
// (names compare without case, as DNS does).
func sameQuestion(got []dnsmessage.Question, want dnsmessage.Question) bool {
	return len(got) == 1 && got[0].Type == want.Type && got[0].Class == want.Class &&
		strings.EqualFold(got[0].Name.String(), want.Name.String())
}

// Cache lifetimes.
const (
	maxPositiveTTL = time.Hour
	maxNegativeTTL = 30 * time.Second
	// noSOATTL is how long NXDOMAIN or NODATA without an SOA is kept.
	noSOATTL = 5 * time.Second
	// staleFor is how long after it expired an answer may still be served
	// while no upstream answers (RFC 8767), and staleTTL the TTL it goes
	// out with.
	staleFor = time.Hour
	staleTTL = 30
)

// lifetime is how long an upstream answer may be served from the cache,
// and whether it may be kept at all: NOERROR with answers for its lowest
// TTL (at most an hour, no floor), NXDOMAIN and NODATA for the SOA's TTL
// or minimum, whichever is lower (at most 30 s; 5 s without an SOA).
// SERVFAIL, REFUSED and the rest are never kept.
func lifetime(m *dnsmessage.Message) (time.Duration, bool) {
	switch m.Header.RCode {
	case dnsmessage.RCodeSuccess:
		if len(m.Answers) > 0 {
			ttl := uint32(maxPositiveTTL / time.Second)
			for _, section := range [][]dnsmessage.Resource{m.Answers, m.Authorities, m.Additionals} {
				for _, rr := range section {
					ttl = min(ttl, rr.Header.TTL)
				}
			}
			return time.Duration(ttl) * time.Second, true
		}
		return negativeTTL(m), true
	case dnsmessage.RCodeNameError:
		return negativeTTL(m), true
	}
	return 0, false
}

func negativeTTL(m *dnsmessage.Message) time.Duration {
	for _, rr := range m.Authorities {
		if soa, ok := rr.Body.(*dnsmessage.SOAResource); ok {
			ttl := min(rr.Header.TTL, soa.MinTTL)
			return min(time.Duration(ttl)*time.Second, maxNegativeTTL)
		}
	}
	return noSOATTL
}

// setTTLs gives every record ttl, or its own minus age when ttl < 0.
func setTTLs(m *dnsmessage.Message, age time.Duration, ttl int) {
	elapsed := uint32(max(age, 0) / time.Second)
	for _, section := range [][]dnsmessage.Resource{m.Answers, m.Authorities, m.Additionals} {
		for i := range section {
			h := &section[i].Header
			switch {
			case ttl >= 0:
				h.TTL = uint32(ttl)
			case h.TTL > elapsed:
				h.TTL -= elapsed
			default:
				h.TTL = 0
			}
		}
	}
}

// reply builds the client's answer from m (an upstream's, without OPT):
// the client's id, RD bit and question as it wrote it (case included), an
// OPT record when the client sent one, and over UDP no more than the
// client takes: an answer that does not fit goes out empty with TC set,
// so the client asks again over TCP.
func reply(m dnsmessage.Message, r request, udp bool) ([]byte, error) {
	m.Header.ID = r.header.ID
	m.Header.Response = true
	m.Header.RecursionDesired = r.header.RecursionDesired
	m.Header.RecursionAvailable = true
	m.Questions = r.questions
	if r.edns {
		var rh dnsmessage.ResourceHeader
		if err := rh.SetEDNS0(ednsSize, dnsmessage.RCodeSuccess, r.do); err != nil {
			return nil, err
		}
		m.Additionals = append(m.Additionals[:len(m.Additionals):len(m.Additionals)], dnsmessage.Resource{Header: rh, Body: &dnsmessage.OPTResource{}})
	}
	out, err := m.Pack()
	if err != nil {
		return nil, err
	}
	limit := maxMessage
	if udp {
		limit = min(r.udpSize, maxMessage)
	}
	if len(out) <= limit {
		return out, nil
	}
	m.Header.Truncated = true
	m.Answers, m.Authorities = nil, nil
	var opt []dnsmessage.Resource
	for _, rr := range m.Additionals {
		if rr.Header.Type == dnsmessage.TypeOPT {
			opt = append(opt, rr)
		}
	}
	m.Additionals = opt
	return m.Pack()
}

// failure is an answer with rcode and no records: SERVFAIL when no
// upstream answered, FORMERR for a message that does not parse.
func failure(r request, rcode dnsmessage.RCode) []byte {
	m := dnsmessage.Message{Header: dnsmessage.Header{RCode: rcode}}
	out, err := reply(m, r, true)
	if err != nil {
		// The client's own question would not pack: answer without it.
		r.questions, r.edns = nil, false
		out, _ = reply(m, r, true)
	}
	return out
}
