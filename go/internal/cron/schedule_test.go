package cron

import (
	"errors"
	"testing"
	"time"
)

func TestParseSchedule(t *testing.T) {
	base := time.Date(2026, 3, 10, 10, 7, 30, 0, time.UTC)
	tests := []struct {
		expr, tz string
		want     time.Time
	}{
		{"*/15 * * * *", "", time.Date(2026, 3, 10, 10, 15, 0, 0, time.UTC)},
		{"0 3 * * *", "", time.Date(2026, 3, 11, 3, 0, 0, 0, time.UTC)},
		{"@hourly", "", time.Date(2026, 3, 10, 11, 0, 0, 0, time.UTC)},
		{"@daily", "", time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC)},
		{"30 9 * * MON-FRI", "", time.Date(2026, 3, 11, 9, 30, 0, 0, time.UTC)},
		// 03:00 in New York (UTC-4 after the March 8 DST change) is 07:00 UTC.
		{"0 3 * * *", "America/New_York", time.Date(2026, 3, 11, 7, 0, 0, 0, time.UTC)},
		{"0 12 1 * *", "Asia/Jerusalem", time.Date(2026, 4, 1, 9, 0, 0, 0, time.UTC)},
	}
	for _, tt := range tests {
		s, err := ParseSchedule(tt.expr, tt.tz)
		if err != nil {
			t.Fatalf("%q %q: %v", tt.expr, tt.tz, err)
		}
		if got := s.Next(base); !got.Equal(tt.want) {
			t.Errorf("%q in %q: Next = %v, want %v", tt.expr, tt.tz, got.UTC(), tt.want)
		}
	}
}

func TestParseScheduleDST(t *testing.T) {
	// Europe/Berlin moves from UTC+1 to UTC+2 on 2026-03-29; a 06:00 job
	// stays at 06:00 local time.
	s, err := ParseSchedule("0 6 * * *", "Europe/Berlin")
	if err != nil {
		t.Fatal(err)
	}
	first := s.Next(time.Date(2026, 3, 27, 12, 0, 0, 0, time.UTC))
	second := s.Next(first)
	if first.UTC().Hour() != 5 || second.UTC().Hour() != 4 {
		t.Fatalf("runs at %v and %v UTC, want 05:00 then 04:00", first.UTC(), second.UTC())
	}
}

func TestParseScheduleRejects(t *testing.T) {
	for _, tt := range []struct{ expr, tz string }{
		{"", ""},
		{"* * * *", ""},
		{"0 0 * * * *", ""}, // seconds field is not supported
		{"61 * * * *", ""},
		{"@every 5m", ""},
		{"CRON_TZ=UTC 0 * * * *", ""},
		{"0 * * * *", "Mars/Olympus"},
	} {
		if _, err := ParseSchedule(tt.expr, tt.tz); !errors.Is(err, ErrBadSchedule) {
			t.Errorf("ParseSchedule(%q, %q) err = %v, want ErrBadSchedule", tt.expr, tt.tz, err)
		}
	}
}
