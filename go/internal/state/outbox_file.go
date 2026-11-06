package state

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Outbox limits. Reports are small (a crash report is at most 100 lines),
// so these only matter when the panel is gone for a long time.
const (
	// DefaultOutboxMaxEntries bounds the number of queued reports.
	DefaultOutboxMaxEntries = 10000
	// DefaultOutboxMaxBytes bounds the total size of queued reports.
	DefaultOutboxMaxBytes = 64 << 20
	// MaxOutboxEntryBytes is the largest single report accepted.
	MaxOutboxEntryBytes = 1 << 20
)

// ErrOutboxEntryTooLarge is returned for a report over MaxOutboxEntryBytes.
var ErrOutboxEntryTooLarge = errors.New("state: report too large for the outbox")

// OutboxOptions configures OpenFileOutbox. Zero values take the defaults.
type OutboxOptions struct {
	MaxEntries int
	MaxBytes   int64
	Logger     *slog.Logger
	// Now is the clock the id floor is read from; default time.Now.
	Now func() time.Time
}

// FileOutbox is the on-disk Outbox: one file per report under dir, named
// by its id (<id>.crash or <id>.event, 20 digits so names sort by id), and
// a "seq" file with the last id handed out. Ids keep increasing across
// restarts even when the queue is empty, because the panel dedupes on
// (node, outbox id) and must never mistake a new report for an old one.
// On open the next id is also at least the current time in microseconds:
// restoring an older copy of the data folder (the one-folder export)
// rolls "seq" back while the node keeps its identity, and without the
// floor the panel would ack and drop new reports whose ids it already
// stored.
//
// Drop policy: when a new report would exceed MaxEntries or MaxBytes, the
// oldest reports are deleted to make room (logged, counted in Dropped).
// New reports are worth more than old ones the panel has missed for days.
type FileOutbox struct {
	dir    string
	opts   OutboxOptions
	logger *slog.Logger

	mu      sync.Mutex
	lastID  uint64
	entries []outboxMeta // sorted by id
	bytes   int64
	dropped uint64
}

type outboxMeta struct {
	id   uint64
	kind string // "crash" or "event"
	size int64
}

var _ Outbox = (*FileOutbox)(nil)

// OpenFileOutbox opens (creating if needed) the outbox in dir. Files that
// do not look like entries are ignored; temp files from an interrupted
// write are removed.
func OpenFileOutbox(dir string, opts OutboxOptions) (*FileOutbox, error) {
	if opts.MaxEntries <= 0 {
		opts.MaxEntries = DefaultOutboxMaxEntries
	}
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultOutboxMaxBytes
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating outbox: %w", err)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	o := &FileOutbox{dir: dir, opts: opts, logger: logger}
	if err := o.load(); err != nil {
		return nil, err
	}
	if floor := opts.Now().UnixMicro(); floor > 0 {
		o.lastID = max(o.lastID, uint64(floor))
	}
	return o, nil
}

func (o *FileOutbox) load() error {
	des, err := os.ReadDir(o.dir)
	if err != nil {
		return fmt.Errorf("reading outbox: %w", err)
	}
	for _, de := range des {
		name := de.Name()
		if strings.HasPrefix(name, ".") && strings.Contains(name, ".tmp-") {
			_ = os.Remove(filepath.Join(o.dir, name))
			continue
		}
		base, kind, ok := strings.Cut(name, ".")
		if !ok || (kind != "crash" && kind != "event") {
			continue
		}
		id, err := strconv.ParseUint(base, 10, 64)
		if err != nil {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		o.entries = append(o.entries, outboxMeta{id: id, kind: kind, size: info.Size()})
		o.bytes += info.Size()
		o.lastID = max(o.lastID, id)
	}
	slices.SortFunc(o.entries, func(a, b outboxMeta) int { return compareUint(a.id, b.id) })

	b, err := os.ReadFile(o.seqPath())
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return fmt.Errorf("reading outbox seq: %w", err)
	default:
		if n, perr := strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64); perr == nil {
			o.lastID = max(o.lastID, n)
		} else {
			o.logger.Warn("outbox seq file is unreadable; continuing after the highest queued id", "err", perr)
		}
	}
	return nil
}

func compareUint(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func (o *FileOutbox) seqPath() string { return filepath.Join(o.dir, "seq") }

func (o *FileOutbox) entryPath(m outboxMeta) string {
	return filepath.Join(o.dir, fmt.Sprintf("%020d.%s", m.id, m.kind))
}

// AppendCrash implements Outbox.
func (o *FileOutbox) AppendCrash(ctx context.Context, report *agentv1.CrashReport) (uint64, error) {
	return o.append(ctx, "crash", report)
}

// AppendEvent implements Outbox.
func (o *FileOutbox) AppendEvent(ctx context.Context, event *agentv1.Event) (uint64, error) {
	return o.append(ctx, "event", event)
}

func (o *FileOutbox) append(ctx context.Context, kind string, msg proto.Message) (uint64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	b, err := proto.Marshal(msg)
	if err != nil {
		return 0, fmt.Errorf("encoding report: %w", err)
	}
	if len(b) > MaxOutboxEntryBytes {
		return 0, fmt.Errorf("%w: %d bytes", ErrOutboxEntryTooLarge, len(b))
	}
	o.mu.Lock()
	defer o.mu.Unlock()

	size := int64(len(b))
	for len(o.entries) > 0 && (len(o.entries)+1 > o.opts.MaxEntries || o.bytes+size > o.opts.MaxBytes) {
		oldest := o.entries[0]
		if err := os.Remove(o.entryPath(oldest)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return 0, fmt.Errorf("making room in the outbox: %w", err)
		}
		o.entries = o.entries[1:]
		o.bytes -= oldest.size
		o.dropped++
		o.logger.Warn("outbox full: dropped the oldest report", "outbox_id", oldest.id, "kind", oldest.kind)
	}

	id := o.lastID + 1
	// The seq file goes first: a crash between the two writes skips an id,
	// which is harmless; reusing one would not be.
	if err := WriteFileAtomic(o.seqPath(), []byte(strconv.FormatUint(id, 10)), 0o600); err != nil {
		return 0, fmt.Errorf("saving outbox seq: %w", err)
	}
	o.lastID = id
	m := outboxMeta{id: id, kind: kind, size: size}
	if err := WriteFileAtomic(o.entryPath(m), b, 0o600); err != nil {
		return 0, fmt.Errorf("saving report: %w", err)
	}
	o.entries = append(o.entries, m)
	o.bytes += size
	return id, nil
}

// Pending implements Outbox. Entries that cannot be read or decoded are
// deleted and logged, so one bad file never blocks the queue.
func (o *FileOutbox) Pending(ctx context.Context, limit int) ([]OutboxEntry, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []OutboxEntry
	for i := 0; i < len(o.entries) && (limit <= 0 || len(out) < limit); {
		m := o.entries[i]
		e, err := o.read(m)
		if err != nil {
			o.logger.Error("dropping unreadable outbox entry", "outbox_id", m.id, "err", err)
			_ = os.Remove(o.entryPath(m))
			o.entries = slices.Delete(o.entries, i, i+1)
			o.bytes -= m.size
			o.dropped++
			continue
		}
		out = append(out, e)
		i++
	}
	return out, nil
}

func (o *FileOutbox) read(m outboxMeta) (OutboxEntry, error) {
	b, err := os.ReadFile(o.entryPath(m))
	if err != nil {
		return OutboxEntry{}, err
	}
	e := OutboxEntry{ID: m.id}
	if m.kind == "crash" {
		e.Crash = &agentv1.CrashReport{}
		err = proto.Unmarshal(b, e.Crash)
	} else {
		e.Event = &agentv1.Event{}
		err = proto.Unmarshal(b, e.Event)
	}
	return e, err
}

// Ack implements Outbox. Acking an unknown id is a no-op.
func (o *FileOutbox) Ack(ctx context.Context, id uint64) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	i := slices.IndexFunc(o.entries, func(m outboxMeta) bool { return m.id == id })
	if i < 0 {
		return nil
	}
	m := o.entries[i]
	if err := os.Remove(o.entryPath(m)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("removing acknowledged report: %w", err)
	}
	o.entries = slices.Delete(o.entries, i, i+1)
	o.bytes -= m.size
	return nil
}

// OutboxStats describes the queue for the local status API.
type OutboxStats struct {
	Pending int
	Bytes   int64
	Dropped uint64
	LastID  uint64
}

// Stats returns the queue's size and how many reports were dropped since
// the outbox was opened.
func (o *FileOutbox) Stats() OutboxStats {
	o.mu.Lock()
	defer o.mu.Unlock()
	return OutboxStats{Pending: len(o.entries), Bytes: o.bytes, Dropped: o.dropped, LastID: o.lastID}
}
