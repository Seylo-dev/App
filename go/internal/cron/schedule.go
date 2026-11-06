package cron

import (
	"errors"
	"fmt"
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
	s, err := parser.Parse(expr)
	if err != nil {
		return nil, fmt.Errorf("%w: %q: %v", ErrBadSchedule, expr, err)
	}
	return zoned{s: s, loc: loc}, nil
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
