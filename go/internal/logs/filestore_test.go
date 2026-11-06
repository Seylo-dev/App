package logs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

var t0 = time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)

func entry(i int, line string) *agentv1.LogEntry {
	return &agentv1.LogEntry{
		Time:        timestamppb.New(t0.Add(time.Duration(i) * time.Second)),
		Stream:      agentv1.LogStream_LOG_STREAM_STDOUT,
		ContainerId: "abc123def456",
		Generation:  uint64(1 + i/100),
		Line:        line,
	}
}

func newStore(t *testing.T) *FileStore {
	t.Helper()
	return NewFileStore(datadir.New(t.TempDir()))
}

func appendN(t *testing.T, s *FileStore, svc string, from, n int) {
	t.Helper()
	for i := from; i < from+n; i++ {
		if err := s.Append(svc, entry(i, fmt.Sprintf("line %d", i))); err != nil {
			t.Fatal(err)
		}
	}
}

func lines(es []*agentv1.LogEntry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.GetLine()
	}
	return out
}

func TestEncodeRoundTrip(t *testing.T) {
	e := entry(3, "tab\there and a\nnewline\r")
	e.Stream = agentv1.LogStream_LOG_STREAM_STDERR
	b := appendEncoded(nil, e)
	if strings.Count(string(b), "\n") != 1 {
		t.Fatalf("encoded entry has inner newlines: %q", b)
	}
	r, ok := parseRecord(b[:len(b)-1])
	if !ok {
		t.Fatal("parse failed")
	}
	got := r.entry()
	if got.GetLine() != "tab\there and a newline " || got.GetStream() != e.GetStream() ||
		got.GetGeneration() != e.GetGeneration() || got.GetContainerId() != e.GetContainerId() ||
		!got.GetTime().AsTime().Equal(e.GetTime().AsTime()) {
		t.Fatalf("round trip = %v", got)
	}
	sys := &agentv1.LogEntry{Time: timestamppb.New(t0), Stream: agentv1.LogStream_LOG_STREAM_SYSTEM, Line: "deploy 2 started"}
	b = appendEncoded(nil, sys)
	r, _ = parseRecord(b[:len(b)-1])
	if r.entry().GetContainerId() != "" {
		t.Fatalf("system line container = %q", r.entry().GetContainerId())
	}
	long := appendEncoded(nil, entry(0, strings.Repeat("x", MaxLineBytes+10)))
	if !strings.HasSuffix(strings.TrimSuffix(string(long), "\n"), truncatedMark) {
		t.Fatal("long line not marked as truncated")
	}
}

func TestTailAcrossRotation(t *testing.T) {
	s := newStore(t)
	// 4 MiB budget = 512 KiB segments; 600 KB of lines rotate once.
	s.SetRetention(Retention{MaxBytes: 4 << 20, MaxAge: time.Hour * 24 * 365})
	big := strings.Repeat("y", 1000)
	for i := range 600 {
		if err := s.Append("svc1", entry(i, fmt.Sprintf("%d %s", i, big))); err != nil {
			t.Fatal(err)
		}
	}
	segs, _ := filepath.Glob(filepath.Join(s.root, "svc1", "*.log"))
	if len(segs) < 2 {
		t.Fatalf("expected rotation, got %d segments", len(segs))
	}
	got, err := s.Tail("svc1", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || !strings.HasPrefix(got[0], "597 ") || !strings.HasPrefix(got[2], "599 ") {
		t.Fatalf("tail = %v", got)
	}
	// A fresh store (agent restart) reads the same files.
	s2 := NewFileStore(s.layout)
	got2, _ := s2.Tail("svc1", 600)
	if len(got2) != 600 || !strings.HasPrefix(got2[0], "0 ") {
		t.Fatalf("after reload: %d lines, first %q", len(got2), got2[0][:5])
	}
}

func TestRetentionBytes(t *testing.T) {
	s := newStore(t)
	s.SetRetention(Retention{MaxBytes: 1 << 20, MaxAge: 24 * time.Hour})
	big := strings.Repeat("z", 2000)
	for i := range 2000 { // about 4 MB
		if err := s.Append("svc1", entry(i, big)); err != nil {
			t.Fatal(err)
		}
	}
	var total int64
	segs, _ := filepath.Glob(filepath.Join(s.root, "svc1", "*.log"))
	for _, p := range segs {
		info, _ := os.Stat(p)
		total += info.Size()
	}
	if total > 1<<20 {
		t.Fatalf("kept %d bytes over a 1 MiB budget", total)
	}
	if total < (1<<20)/2 {
		t.Fatalf("kept only %d bytes", total)
	}
	got, _ := s.Tail("svc1", 1)
	if len(got) != 1 {
		t.Fatal("newest line lost")
	}
}

func TestRetentionAge(t *testing.T) {
	s := newStore(t)
	s.SetRetention(Retention{MaxBytes: 1 << 30, MaxAge: time.Hour})
	appendN(t, s, "svc1", 0, 10)
	seg := filepath.Join(s.root, "svc1", segmentName(1))
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(seg, old, old); err != nil {
		t.Fatal(err)
	}
	if err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(seg); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old segment survived")
	}
	got, _ := s.Tail("svc1", 10)
	if len(got) != 0 {
		t.Fatalf("tail after prune = %v", got)
	}
	appendN(t, s, "svc1", 10, 2)
	got, _ = s.Tail("svc1", 10)
	if len(got) != 2 {
		t.Fatalf("appends after prune = %v", got)
	}
}

func TestSearch(t *testing.T) {
	s := newStore(t)
	for i := range 50 {
		line := fmt.Sprintf("request %d ok", i)
		if i%10 == 0 {
			line = fmt.Sprintf("request %d FAILED: timeout", i)
		}
		if err := s.Append("svc1", entry(i, line)); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()

	resp, err := s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: "failed"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"request 40 FAILED: timeout", "request 30 FAILED: timeout", "request 20 FAILED: timeout", "request 10 FAILED: timeout", "request 0 FAILED: timeout"}
	if got := lines(resp.GetEntries()); strings.Join(got, "|") != strings.Join(want, "|") || resp.GetNextCursor() != "" {
		t.Fatalf("substring search = %v cursor %q", got, resp.GetNextCursor())
	}

	resp, err = s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: `^request [1-2]\d ok$`, Regex: true, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if got := lines(resp.GetEntries()); len(got) != 5 || got[0] != "request 29 ok" || resp.GetNextCursor() == "" {
		t.Fatalf("regex page 1 = %v cursor %q", got, resp.GetNextCursor())
	}
	var all []string
	all = append(all, lines(resp.GetEntries())...)
	for resp.GetNextCursor() != "" {
		resp, err = s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: `^request [1-2]\d ok$`, Regex: true, Limit: 5, Cursor: resp.GetNextCursor()})
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, lines(resp.GetEntries())...)
	}
	if len(all) != 18 || all[17] != "request 11 ok" {
		t.Fatalf("paged regex = %d %v", len(all), all)
	}

	resp, _ = s.Search(ctx, &agentv1.LogsSearchRequest{
		ServiceId: "svc1",
		Since:     timestamppb.New(t0.Add(5 * time.Second)),
		Until:     timestamppb.New(t0.Add(7 * time.Second)),
	})
	if got := lines(resp.GetEntries()); strings.Join(got, "|") != "request 7 ok|request 6 ok|request 5 ok" {
		t.Fatalf("time window = %v", got)
	}

	if _, err := s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "svc1", Query: "(", Regex: true}); !errors.Is(err, ErrBadQuery) {
		t.Fatalf("bad regex err = %v", err)
	}
	if _, err := s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "svc1", Cursor: "nope"}); !errors.Is(err, ErrBadCursor) {
		t.Fatalf("bad cursor err = %v", err)
	}
	if _, err := s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "../etc"}); !errors.Is(err, ErrInvalidTarget) {
		t.Fatalf("bad id err = %v", err)
	}
	resp, _ = s.Search(ctx, &agentv1.LogsSearchRequest{ServiceId: "nothing-here"})
	if len(resp.GetEntries()) != 0 {
		t.Fatal("unknown service has entries")
	}
}

func TestFollowHistoryThenLive(t *testing.T) {
	s := newStore(t)
	appendN(t, s, "svc1", 0, 300)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	var got []string
	gotN := make(chan int, 100)
	errc := make(chan error, 1)
	go func() {
		errc <- s.Follow(ctx, &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_ServiceId{ServiceId: "svc1"}, Tail: 5}, func(es []*agentv1.LogEntry) error {
			mu.Lock()
			got = append(got, lines(es)...)
			n := len(got)
			mu.Unlock()
			gotN <- n
			return nil
		})
	}()
	waitN(t, gotN, 5)
	appendN(t, s, "svc1", 300, 2)
	waitN(t, gotN, 7)
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("follow returned %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := "line 295|line 296|line 297|line 298|line 299|line 300|line 301"
	if strings.Join(got, "|") != want {
		t.Fatalf("follow = %v", got)
	}
}

func TestFollowSince(t *testing.T) {
	s := newStore(t)
	appendN(t, s, "svc1", 0, 10)
	ctx, cancel := context.WithCancel(context.Background())
	var got []string
	_ = s.Follow(ctx, &agentv1.LogsFollowRequest{
		Target: &agentv1.LogsFollowRequest_ServiceId{ServiceId: "svc1"},
		Since:  timestamppb.New(t0.Add(7 * time.Second)),
	}, func(es []*agentv1.LogEntry) error {
		got = append(got, lines(es)...)
		cancel()
		return nil
	})
	if strings.Join(got, "|") != "line 8|line 9" {
		t.Fatalf("since = %v", got)
	}
}

func waitN(t *testing.T, ch <-chan int, n int) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case got := <-ch:
			if got >= n {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %d lines", n)
		}
	}
}

func TestBuildLogFollowEnds(t *testing.T) {
	s := newStore(t)
	w, err := s.BuildLog("b1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("step 1\nstep 2 par")); err != nil {
		t.Fatal(err)
	}
	var got []string
	done := make(chan error, 1)
	go func() {
		done <- s.Follow(context.Background(), &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_BuildId{BuildId: "b1"}}, func(es []*agentv1.LogEntry) error {
			got = append(got, lines(es)...)
			return nil
		})
	}()
	time.Sleep(50 * time.Millisecond)
	_, _ = w.Write([]byte("tial\r\nlast without newline"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("build follow did not end after Close")
	}
	if strings.Join(got, "|") != "step 1|step 2 partial|last without newline" {
		t.Fatalf("build log = %v", got)
	}
	// Following a complete build log later replays it and ends at once.
	got = nil
	if err := NewFileStore(s.layout).Follow(context.Background(), &agentv1.LogsFollowRequest{Target: &agentv1.LogsFollowRequest_BuildId{BuildId: "b1"}}, func(es []*agentv1.LogEntry) error {
		got = append(got, lines(es)...)
		return nil
	}); err != nil || len(got) != 3 {
		t.Fatalf("replay = %v, %v", got, err)
	}
}

func TestSubscriberOverflowKeepsNewest(t *testing.T) {
	s := newSubscriber()
	batch := make([]*agentv1.LogEntry, maxQueue+10)
	for i := range batch {
		batch[i] = entry(i, fmt.Sprint(i))
	}
	s.push(batch[:10])
	s.push(batch[10:])
	q, dropped := s.take()
	if dropped != 10 || len(q) != maxQueue || q[len(q)-1].GetLine() != fmt.Sprint(maxQueue+9) || q[0].GetLine() != "10" {
		t.Fatalf("dropped %d, len %d, first %s", dropped, len(q), q[0].GetLine())
	}
	var sent [][]*agentv1.LogEntry
	s.push(batch[:maxQueue])
	s.push(batch[:5])
	_ = sendLive(s, func(es []*agentv1.LogEntry) error { sent = append(sent, es); return nil })
	if first := sent[0][0]; first.GetStream() != agentv1.LogStream_LOG_STREAM_SYSTEM || !strings.Contains(first.GetLine(), "5 lines skipped") {
		t.Fatalf("first live entry = %v", first)
	}
}

func TestDelete(t *testing.T) {
	s := newStore(t)
	appendN(t, s, "svc1", 0, 3)
	if err := s.Delete("svc1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "svc1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("folder survived")
	}
	appendN(t, s, "svc1", 3, 1)
	got, _ := s.Tail("svc1", 5)
	if len(got) != 1 {
		t.Fatalf("after delete = %v", got)
	}
}
