package cron

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	// Time zones must work on nodes without system tzdata (minimal images,
	// static binary).
	_ "time/tzdata"

	robfig "github.com/robfig/cron/v3"
)

// ErrBadSchedule means a cron expression or time zone is invalid.
var ErrBadSchedule = errors.New("invalid cron schedule")

// parser accepts the standard 5 fields (minute hour day-of-month month
// day-of-week) and the @hourly/@daily/@weekly/@monthly/@yearly
// descriptors. Seconds are deliberately not supported.
var parser = robfig.NewParser(robfig.Minute | robfig.Hour | robfig.Dom | robfig.Month | robfig.Dow | robfig.Descriptor)

// Schedule says when a job fires.
type Schedule interface {
	// Next returns the first activation strictly after t.
	Next(t time.Time) time.Time
}

// ParseSchedule parses a 5-field expression in an IANA time zone (empty
// means UTC). "@every <duration>" is refused: jobs follow the wall clock.
func ParseSchedule(expr, timeZone string) (Schedule, error) {
	loc := time.UTC
	if timeZone != "" {
		l, err := time.LoadLocation(timeZone)
		if err != nil {
			return nil, fmt.Errorf("%w: time zone %q: %v", ErrBadSchedule, timeZone, err)
		}
		loc = l
	}
	return ParseScheduleIn(expr, loc)
}

// ParseScheduleIn is ParseSchedule in a given location, for schedules that
// follow the machine's own clock (time.Local), such as scheduled cleanup.
func ParseScheduleIn(expr string, loc *time.Location) (Schedule, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return nil, fmt.Errorf("%w: empty expression", ErrBadSchedule)
	}
	if strings.HasPrefix(expr, "@every") || strings.Contains(expr, "TZ=") {
		return nil, fmt.Errorf("%w: %q is not supported", ErrBadSchedule, expr)
	}
	s, err := parser.Parse(sundayAsZero(expr))
	if err != nil {
		return nil, fmt.Errorf("%w: %q: %v", ErrBadSchedule, expr, err)
	}
	return zoned{s: s, loc: loc}, nil
}

// sundayAsZero rewrites a day-of-week 7 to 0. Standard cron and the panel
// read 7 as Sunday, but the parser only knows 0-6, so "0 4 * * 7" or
// "0 4 * * 1-7" would be refused and the job never scheduled. Numeric
// tokens that use 7 are expanded to an explicit list of days; names
// (MON-FRI), "*" and tokens without 7 pass through unchanged, so the
// parser still reports anything invalid.
func sundayAsZero(expr string) string {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return expr
	}
	tokens := strings.Split(fields[4], ",")
	for i, tok := range tokens {
		if days, ok := expandDowWithSeven(tok); ok {
			tokens[i] = days
		}
	}
	fields[4] = strings.Join(tokens, ",")
	return strings.Join(fields, " ")
}

// expandDowWithSeven turns a numeric day-of-week token that mentions 7
// ("7", "5-7", "1-7/2", "7/1") into a comma list of days 0-6. It reports
// false for anything else, which then goes to the parser as written.
func expandDowWithSeven(tok string) (string, bool) {
	base, stepText, hasStep := strings.Cut(tok, "/")
	lo, hi := base, base
	if a, b, isRange := strings.Cut(base, "-"); isRange {
		lo, hi = a, b
	} else if hasStep {
		hi = "7" // "n/s" runs from n to the last day
	}
	from, err1 := strconv.Atoi(lo)
	to, err2 := strconv.Atoi(hi)
	if err1 != nil || err2 != nil || (from != 7 && to != 7) || from < 0 || to > 7 || from > to {
		return "", false
	}
	step := 1
	if hasStep {
		n, err := strconv.Atoi(stepText)
		if err != nil || n < 1 {
			return "", false
		}
		step = n
	}
	seen := map[int]bool{}
	var days []string
	for d := from; d <= to; d += step {
		day := d % 7
		if !seen[day] {
			seen[day] = true
			days = append(days, strconv.Itoa(day))
		}
	}
	return strings.Join(days, ","), true
}

// zoned evaluates a schedule in its own time zone, so "0 3 * * *" in
// Europe/Berlin is 03:00 Berlin time on both sides of a DST change.
type zoned struct {
	s   robfig.Schedule
	loc *time.Location
}

func (z zoned) Next(t time.Time) time.Time {
	return z.s.Next(t.In(z.loc))
}
