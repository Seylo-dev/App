package agent

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/state"
)

// diskAlertPercent is the use above which the node raises DISK_LOW. No
// panel setting changes it; the alert rule's label says "Disk above 85%".
const diskAlertPercent = 85

// diskCheckEvery is how often the data dir's and Docker's file systems are
// checked. A variable so tests can shorten it.
var diskCheckEvery = 10 * time.Minute

// fsUse is one file system as fsUsage reads it.
type fsUse struct {
	// path is the folder that was read (the nearest existing one).
	path string
	// dev identifies the file system, so a data dir and a Docker root on
	// the same disk count once.
	dev         uint64
	used, avail uint64
}

func (u fsUse) percent() float64 {
	if u.used+u.avail == 0 {
		return 0
	}
	return float64(u.used) * 100 / float64(u.used+u.avail)
}

// diskPath is a folder the node needs space in.
type diskPath struct {
	name, path string
}

// diskWatch raises one DISK_LOW alert while the file system holding the
// data dir or Docker's root is more than diskAlertPercent full, and
// resolves it when every one is back under the line. The first check after
// a start that finds the disks fine also resolves, since an alert raised
// before a restart is not remembered (the panel ignores a resolve without
// an open alert).
type diskWatch struct {
	paths   func(ctx context.Context) []diskPath
	stat    func(path string) (fsUse, error)
	reports func() state.Reporter
	logger  *slog.Logger
	// onUse, when set, gets the fullest file system's use in percent after
	// every check (the scheduled cleanup's disk trigger).
	onUse func(percent float64)

	// Owned by the run goroutine.
	checked bool
	alerted bool
}

func (w *diskWatch) run(ctx context.Context) error {
	for {
		w.check(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(diskCheckEvery):
		}
	}
}

// diskFS is one file system and the folders on it.
type diskFS struct {
	use   fsUse
	names []string
	paths []string
}

func (w *diskWatch) check(ctx context.Context) {
	var all []*diskFS
	for _, p := range w.paths(ctx) {
		u, err := w.stat(p.path)
		if err != nil {
			w.logger.Warn("reading disk use", "path", p.path, "err", err)
			continue
		}
		i := slices.IndexFunc(all, func(f *diskFS) bool { return f.use.dev == u.dev })
		if i < 0 {
			all = append(all, &diskFS{use: u})
			i = len(all) - 1
		}
		all[i].names = append(all[i].names, p.name)
		all[i].paths = append(all[i].paths, p.path)
	}
	if len(all) == 0 {
		return
	}
	if w.onUse != nil {
		fullest := 0.0
		for _, f := range all {
			fullest = max(fullest, f.use.percent())
		}
		w.onUse(fullest)
	}
	full := slices.DeleteFunc(all, func(f *diskFS) bool { return f.use.percent() <= diskAlertPercent })
	first := !w.checked
	w.checked = true
	var alert *agentv1.NodeAlert
	switch {
	case len(full) > 0 && !w.alerted:
		w.alerted = true
		alert = &agentv1.NodeAlert{
			Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_DISK_LOW,
			Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING,
			Message:  diskMessage(full),
		}
	case len(full) == 0 && (w.alerted || first):
		w.alerted = false
		alert = &agentv1.NodeAlert{
			Kind:     agentv1.NodeAlertKind_NODE_ALERT_KIND_DISK_LOW,
			Severity: agentv1.AlertSeverity_ALERT_SEVERITY_INFO,
			Message:  fmt.Sprintf("Disk use is back under %d%%", diskAlertPercent),
			Resolved: true,
		}
	}
	if alert == nil {
		return
	}
	r := w.reports()
	if r == nil {
		return
	}
	if err := r.Event(ctx, &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: alert}}); err != nil {
		w.logger.Error("queueing the disk alert", "err", err)
	}
}

// diskMessage is the alert text: the first line is its title in the panel.
func diskMessage(full []*diskFS) string {
	parts := make([]string, 0, len(full))
	free := make([]string, 0, len(full))
	for _, f := range full {
		parts = append(parts, fmt.Sprintf("%.0f%% full on %s (%s)", f.use.percent(), strings.Join(f.paths, ", "), strings.Join(f.names, " and ")))
		free = append(free, fmt.Sprintf("%s free of %s", sizeText(f.use.avail), sizeText(f.use.used+f.use.avail)))
	}
	return fmt.Sprintf("Disk %s\n%s. Free space: remove unused images and build cache from the node's Cleanup tab (it can also run on a schedule or when a disk fills up), or grow the disk. "+
		"Checked every %d minutes; the alert clears under %d%%.", strings.Join(parts, "; "), strings.Join(free, "; "), int(diskCheckEvery/time.Minute), diskAlertPercent)
}

func sizeText(n uint64) string {
	const gib = 1 << 30
	if n >= gib {
		return strconv.FormatFloat(float64(n)/gib, 'f', 1, 64) + " GiB"
	}
	return strconv.FormatFloat(float64(n)/(1<<20), 'f', 0, 64) + " MiB"
}
