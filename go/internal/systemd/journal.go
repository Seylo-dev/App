package systemd

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// JournalEntry is one journal line of a unit.
type JournalEntry struct {
	Time time.Time
	// Level is "debug", "info", "warn" or "error": from a slog
	// "level=..." attribute when the line has one, else the syslog
	// priority.
	Level   string
	Message string
}

// JournalOptions picks the lines Journal returns.
type JournalOptions struct {
	// Lines from the end; 0 means 500.
	Tail int
	// Since overrides Tail when set.
	Since time.Time
}

// Journal reads a unit's journal as JSON (`journalctl -o json`), oldest
// first.
func (u *Units) Journal(ctx context.Context, unit string, opts JournalOptions) ([]JournalEntry, error) {
	args := []string{"--unit", unit, "--no-pager", "--output", "json", "--output-fields", "MESSAGE,PRIORITY"}
	if !opts.Since.IsZero() {
		args = append(args, "--since", "@"+strconv.FormatInt(opts.Since.Unix(), 10))
	} else {
		tail := opts.Tail
		if tail <= 0 {
			tail = 500
		}
		args = append(args, "--lines", strconv.Itoa(tail))
	}
	var out bytes.Buffer
	if err := u.run(ctx, &out, "journalctl", args...); err != nil {
		return nil, err
	}
	return parseJournalJSON(out.Bytes()), nil
}

// parseJournalJSON reads `journalctl -o json` output. MESSAGE may be a
// string or, for non-UTF-8 text, an array of bytes.
func parseJournalJSON(data []byte) []JournalEntry {
	var entries []JournalEntry
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var raw struct {
			Realtime string          `json:"__REALTIME_TIMESTAMP"`
			Message  json.RawMessage `json:"MESSAGE"`
			Priority string          `json:"PRIORITY"`
		}
		if json.Unmarshal(sc.Bytes(), &raw) != nil {
			continue
		}
		var msg string
		if json.Unmarshal(raw.Message, &msg) != nil {
			var b []byte
			var ints []int
			if json.Unmarshal(raw.Message, &ints) == nil {
				for _, i := range ints {
					b = append(b, byte(i))
				}
			}
			msg = string(b)
		}
		e := JournalEntry{Message: msg, Level: levelOf(msg, raw.Priority)}
		if us, err := strconv.ParseInt(raw.Realtime, 10, 64); err == nil {
			e.Time = time.UnixMicro(us).UTC()
		}
		entries = append(entries, e)
	}
	return entries
}

func levelOf(msg, priority string) string {
	if i := strings.Index(msg, "level="); i >= 0 {
		v := strings.ToLower(strings.Fields(msg[i+len("level="):] + " ")[0])
		switch {
		case strings.HasPrefix(v, "debug"):
			return "debug"
		case strings.HasPrefix(v, "warn"):
			return "warn"
		case strings.HasPrefix(v, "err"):
			return "error"
		case strings.HasPrefix(v, "info"):
			return "info"
		}
	}
	switch priority {
	case "0", "1", "2", "3":
		return "error"
	case "4":
		return "warn"
	case "7":
		return "debug"
	}
	return "info"
}
