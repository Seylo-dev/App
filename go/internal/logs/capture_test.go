package logs

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

type captured struct {
	stream agentv1.LogStream
	ts     time.Time
	line   string
}

func frame(stream byte, payload string) []byte {
	var h [8]byte
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h[:], payload...)
}

func ts(sec int) string { return t0.Add(time.Duration(sec) * time.Second).Format(time.RFC3339Nano) }

func TestParserFramesJoinsPartials(t *testing.T) {
	var got []captured
	p := &lineParser{emit: func(s agentv1.LogStream, at time.Time, line []byte) {
		got = append(got, captured{s, at, string(line)})
	}}
	var buf bytes.Buffer
	buf.Write(frame(1, ts(1)+" hello\n"))
	buf.Write(frame(2, ts(2)+" part one "))
	buf.Write(frame(1, ts(3)+" interleaved\n"))
	buf.Write(frame(2, ts(4)+" part two\n"))
	buf.Write(frame(1, ts(5)+" no newline at end"))
	if err := p.readFrames(&buf); err == nil || !strings.Contains(err.Error(), "EOF") {
		t.Fatalf("readFrames = %v", err)
	}
	p.flush()
	want := []captured{
		{agentv1.LogStream_LOG_STREAM_STDOUT, t0.Add(1 * time.Second), "hello"},
		{agentv1.LogStream_LOG_STREAM_STDOUT, t0.Add(3 * time.Second), "interleaved"},
		{agentv1.LogStream_LOG_STREAM_STDERR, t0.Add(2 * time.Second), "part one part two"},
		{agentv1.LogStream_LOG_STREAM_STDOUT, t0.Add(5 * time.Second), "no newline at end"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestParserRawSkipsBeforeCursor(t *testing.T) {
	var got []string
	p := &lineParser{since: t0.Add(2 * time.Second), emit: func(_ agentv1.LogStream, _ time.Time, line []byte) {
		got = append(got, string(line))
	}}
	in := ts(1) + " old\r\n" + ts(2) + " also old\r\n" + ts(3) + " new\r\n" + "no timestamp\n"
	_ = p.readRaw(strings.NewReader(in))
	if strings.Join(got, "|") != "new|no timestamp" {
		t.Fatalf("raw = %v", got)
	}
}

func TestCursorFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.json")
	c := newCursorFile(path)
	c.set("a", t0)
	c.set("a", t0.Add(-time.Second)) // never goes back
	c.set("b", t0)
	if err := c.save(); err != nil {
		t.Fatal(err)
	}
	c2 := newCursorFile(path)
	if err := c2.load(); err != nil {
		t.Fatal(err)
	}
	if !c2.get("a").Equal(t0) {
		t.Fatalf("a = %v", c2.get("a"))
	}
	c2.retain(map[string]bool{"a": true})
	if !c2.get("b").IsZero() {
		t.Fatal("b survived retain")
	}
}
