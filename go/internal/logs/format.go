package logs

import (
	"bytes"
	"strconv"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// On disk every entry is one text line:
//
//	<unix nanos> TAB <stream> TAB <generation> TAB <container id or -> TAB <line> LF
//
// The line is the rest after the fourth tab, so tabs inside it are fine;
// newlines never occur because output is split into lines before storing.
// Plain text keeps the files greppable on the node.

// MaxLineBytes caps one stored line. Longer lines are cut and marked.
const MaxLineBytes = 64 << 10

const truncatedMark = " [truncated]"

// appendEncoded appends the on-disk form of e to b.
func appendEncoded(b []byte, e *agentv1.LogEntry) []byte {
	b = strconv.AppendInt(b, e.GetTime().AsTime().UnixNano(), 10)
	b = append(b, '\t')
	b = strconv.AppendInt(b, int64(e.GetStream()), 10)
	b = append(b, '\t')
	b = strconv.AppendUint(b, e.GetGeneration(), 10)
	b = append(b, '\t')
	if id := e.GetContainerId(); id != "" {
		b = append(b, id...)
	} else {
		b = append(b, '-')
	}
	b = append(b, '\t')
	b = appendClean(b, e.GetLine())
	return append(b, '\n')
}

// appendClean appends line without newlines and capped at MaxLineBytes.
func appendClean(b []byte, line string) []byte {
	cut := false
	if len(line) > MaxLineBytes {
		line, cut = line[:MaxLineBytes], true
	}
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '\n' || c == '\r' {
			c = ' '
		}
		b = append(b, c)
	}
	if cut {
		b = append(b, truncatedMark...)
	}
	return b
}

// record is a parsed line that has not been turned into a LogEntry yet,
// so searches can skip most lines without allocating.
type record struct {
	nanos     int64
	stream    agentv1.LogStream
	gen       uint64
	container []byte
	line      []byte
}

// parseRecord parses one stored line (without its newline).
func parseRecord(b []byte) (record, bool) {
	var r record
	var fields [4][]byte
	rest := b
	for i := range fields {
		j := bytes.IndexByte(rest, '\t')
		if j < 0 {
			return r, false
		}
		fields[i], rest = rest[:j], rest[j+1:]
	}
	nanos, err := strconv.ParseInt(string(fields[0]), 10, 64)
	if err != nil {
		return r, false
	}
	stream, err := strconv.ParseInt(string(fields[1]), 10, 32)
	if err != nil {
		return r, false
	}
	gen, err := strconv.ParseUint(string(fields[2]), 10, 64)
	if err != nil {
		return r, false
	}
	r.nanos, r.stream, r.gen, r.line = nanos, agentv1.LogStream(stream), gen, rest
	if !bytes.Equal(fields[3], []byte("-")) {
		r.container = fields[3]
	}
	return r, true
}

func (r record) time() time.Time { return time.Unix(0, r.nanos) }

func (r record) entry() *agentv1.LogEntry {
	return &agentv1.LogEntry{
		Time:        timestamppb.New(r.time()),
		Stream:      r.stream,
		ContainerId: string(r.container),
		Generation:  r.gen,
		Line:        string(r.line),
	}
}

// eachLineReverse calls fn for every complete line of data from the last
// to the first with the line's start offset; fn returns false to stop.
// A trailing fragment without a newline (a write in progress) is skipped.
func eachLineReverse(data []byte, fn func(line []byte, start int) bool) {
	end := bytes.LastIndexByte(data, '\n')
	for end >= 0 {
		start := bytes.LastIndexByte(data[:end], '\n') + 1
		if !fn(data[start:end], start) {
			return
		}
		end = start - 1
	}
}
