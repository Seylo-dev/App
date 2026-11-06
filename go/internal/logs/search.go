package logs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Search limits.
const (
	DefaultSearchLimit = 500
	MaxSearchLimit     = 5000
	// maxQueryBytes bounds a query (and so the compiled regex).
	maxQueryBytes = 1000
	// scanBudget bounds the bytes one Search call reads. When it runs out
	// the call returns what it found with a cursor, so a search over a
	// large history is a few quick calls instead of one slow one.
	scanBudget = 64 << 20
)

// ErrBadQuery means the query is too long or not a valid RE2 expression.
var ErrBadQuery = errors.New("logs: bad query")

// ErrBadCursor means the cursor did not come from a previous response.
var ErrBadCursor = errors.New("logs: bad cursor")

type matcher func(line []byte) bool

func newMatcher(query string, regex bool) (matcher, error) {
	if len(query) > maxQueryBytes {
		return nil, fmt.Errorf("%w: longer than %d bytes", ErrBadQuery, maxQueryBytes)
	}
	if query == "" {
		return func([]byte) bool { return true }, nil
	}
	if regex {
		re, err := regexp.Compile(query)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadQuery, err)
		}
		return re.Match, nil
	}
	if isASCII(query) {
		q := []byte(strings.ToLower(query))
		var buf []byte
		return func(line []byte) bool {
			buf = lowerASCII(buf[:0], line)
			return bytes.Contains(buf, q)
		}, nil
	}
	q := bytes.ToLower([]byte(query))
	return func(line []byte) bool { return bytes.Contains(bytes.ToLower(line), q) }, nil
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func lowerASCII(dst, src []byte) []byte {
	for _, c := range src {
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		dst = append(dst, c)
	}
	return dst
}

func formatCursor(p position) string {
	return strconv.FormatUint(p.seq, 10) + ":" + strconv.FormatInt(p.off, 10)
}

func parseCursor(s string) (position, error) {
	a, b, ok := strings.Cut(s, ":")
	seq, err1 := strconv.ParseUint(a, 10, 64)
	off, err2 := strconv.ParseInt(b, 10, 64)
	if !ok || err1 != nil || err2 != nil || off < 0 {
		return position{}, ErrBadCursor
	}
	return position{seq: seq, off: off}, nil
}

// Search implements Store.
func (s *FileStore) Search(ctx context.Context, req *agentv1.LogsSearchRequest) (*agentv1.LogsSearchResponse, error) {
	lg, err := s.get(logKey{id: req.GetServiceId()})
	if err != nil {
		return nil, err
	}
	match, err := newMatcher(req.GetQuery(), req.GetRegex())
	if err != nil {
		return nil, err
	}
	limit := int(req.GetLimit())
	if limit <= 0 {
		limit = DefaultSearchLimit
	}
	limit = min(limit, MaxSearchLimit)

	lg.mu.Lock()
	end := lg.end()
	lg.mu.Unlock()
	if c := req.GetCursor(); c != "" {
		p, err := parseCursor(c)
		if err != nil {
			return nil, err
		}
		if p.seq < end.seq || (p.seq == end.seq && p.off <= end.off) {
			end = p
		}
	}
	var since, until int64
	if req.GetSince() != nil {
		since = req.GetSince().AsTime().UnixNano()
	}
	if req.GetUntil() != nil {
		until = req.GetUntil().AsTime().UnixNano()
	}

	resp := &agentv1.LogsSearchResponse{}
	segs := lg.snapshot(end)
	scanned := 0
	for i := len(segs) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		seg := segs[i]
		if scanned >= scanBudget {
			resp.NextCursor = formatCursor(position{seq: seg.seq, off: seg.size})
			break
		}
		data, err := lg.readSegment(seg)
		if err != nil {
			return nil, err
		}
		scanned += len(data)
		done := false
		eachLineReverse(data, func(line []byte, start int) bool {
			r, ok := parseRecord(line)
			if !ok {
				return true
			}
			if until != 0 && r.nanos > until {
				return true
			}
			if since != 0 && r.nanos < since {
				done = true
				return false
			}
			if !match(r.line) {
				return true
			}
			resp.Entries = append(resp.Entries, r.entry())
			if len(resp.Entries) >= limit {
				done = true
				if start > 0 || i > 0 {
					resp.NextCursor = formatCursor(position{seq: seg.seq, off: int64(start)})
				}
				return false
			}
			return true
		})
		if done {
			break
		}
	}
	return resp, nil
}
