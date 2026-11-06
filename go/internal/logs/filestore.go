package logs

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/datadir"
)

// Retention bounds what one service keeps. The oldest segments go first
// when either limit is reached.
type Retention struct {
	MaxBytes int64
	MaxAge   time.Duration
}

// Defaults when the panel sends zero values (see LogRetention in
// desired.proto).
const (
	DefaultMaxBytes = 100 << 20
	DefaultMaxAge   = 14 * 24 * time.Hour
)

// RetentionFrom turns the panel's settings into a Retention with defaults
// filled in.
func RetentionFrom(r *agentv1.LogRetention) Retention {
	out := Retention{MaxBytes: int64(r.GetMaxBytesPerService()), MaxAge: r.GetMaxAge().AsDuration()}
	if out.MaxBytes <= 0 {
		out.MaxBytes = DefaultMaxBytes
	}
	if out.MaxAge <= 0 {
		out.MaxAge = DefaultMaxAge
	}
	return out
}

// segmentBytes is the size at which the active segment is closed: an
// eighth of the budget, so retention trims in small steps, within
// [256 KiB, 8 MiB] so a search reads bounded chunks.
func (r Retention) segmentBytes() int64 {
	return min(max(r.MaxBytes/8, 256<<10), 8<<20)
}

// buildsDir holds build logs next to the service folders. The leading dot
// keeps it apart from service ids, which never start with one.
const buildsDir = ".builds"

// idleClose is how long an unused log keeps its file handle open.
const idleClose = 10 * time.Minute

// FileStore is the Store on disk: logs/<service id>/<seq>.log segments,
// and logs/.builds/<build id>/ for builds. Safe for concurrent use.
type FileStore struct {
	layout datadir.Layout
	root   string
	now    func() time.Time

	mu   sync.Mutex
	logs map[logKey]*serviceLog
	ret  atomic.Pointer[Retention]
}

type logKey struct {
	build bool
	id    string
}

// NewFileStore returns a store under the layout's logs folder.
func NewFileStore(layout datadir.Layout) *FileStore {
	s := &FileStore{layout: layout, root: filepath.Join(layout.Root(), "logs"), now: time.Now, logs: map[logKey]*serviceLog{}}
	r := Retention{MaxBytes: DefaultMaxBytes, MaxAge: DefaultMaxAge}
	s.ret.Store(&r)
	return s
}

// SetRetention changes the limits for every service; the next append or
// Prune applies them.
func (s *FileStore) SetRetention(r Retention) {
	if r.MaxBytes <= 0 {
		r.MaxBytes = DefaultMaxBytes
	}
	if r.MaxAge <= 0 {
		r.MaxAge = DefaultMaxAge
	}
	s.ret.Store(&r)
}

func (s *FileStore) retention() Retention { return *s.ret.Load() }

// ErrInvalidTarget means a request named no service or build, or an id
// that cannot be a folder name.
var ErrInvalidTarget = errors.New("logs: invalid target")

func (s *FileStore) dir(k logKey) (string, error) {
	// ServiceLogs validates the id for both kinds.
	dir, err := s.layout.ServiceLogs(k.id)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidTarget, err)
	}
	if k.build {
		return filepath.Join(s.root, buildsDir, k.id), nil
	}
	return dir, nil
}

// get returns the in-memory handle of a log, loading its segment list.
func (s *FileStore) get(k logKey) (*serviceLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if lg, ok := s.logs[k]; ok {
		return lg, nil
	}
	dir, err := s.dir(k)
	if err != nil {
		return nil, err
	}
	lg := &serviceLog{dir: dir, build: k.build, subs: map[*subscriber]struct{}{}, done: make(chan struct{})}
	if err := lg.load(); err != nil {
		return nil, err
	}
	s.logs[k] = lg
	return lg, nil
}

// Append implements Store.
func (s *FileStore) Append(serviceID string, entries ...*agentv1.LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	lg, err := s.get(logKey{id: serviceID})
	if err != nil {
		return err
	}
	return lg.append(entries, s.retention(), s.now())
}

// Tail implements Store.
func (s *FileStore) Tail(serviceID string, n int) ([]string, error) {
	lg, err := s.get(logKey{id: serviceID})
	if err != nil {
		return nil, err
	}
	lg.mu.Lock()
	end := lg.end()
	lg.mu.Unlock()
	recs, err := lg.readTail(n, end)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(recs))
	for i, r := range recs {
		out[i] = r.Line
	}
	return out, nil
}

// Delete implements Store.
func (s *FileStore) Delete(serviceID string) error {
	lg, err := s.get(logKey{id: serviceID})
	if err != nil {
		return err
	}
	lg.mu.Lock()
	defer lg.mu.Unlock()
	lg.closeFile()
	lg.segs = nil
	if err := os.RemoveAll(lg.dir); err != nil {
		return fmt.Errorf("deleting logs of %s: %w", serviceID, err)
	}
	return nil
}

// Prune applies the age limit to every log on disk, removes build logs
// past it, and closes file handles of idle logs. The agent runs it every
// few minutes.
func (s *FileStore) Prune() error {
	ret := s.retention()
	now := s.now()
	entries, err := os.ReadDir(s.root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("listing logs: %w", err)
	}
	var errs []error
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if e.Name() == buildsDir {
			errs = append(errs, s.pruneBuilds(now.Add(-ret.MaxAge)))
			continue
		}
		lg, err := s.get(logKey{id: e.Name()})
		if err != nil {
			continue // not one of ours
		}
		errs = append(errs, lg.pruneAge(now.Add(-ret.MaxAge)))
	}
	s.mu.Lock()
	for k, lg := range s.logs {
		if lg.closeIfIdle(now) {
			delete(s.logs, k)
		}
	}
	s.mu.Unlock()
	return errors.Join(errs...)
}

func (s *FileStore) pruneBuilds(before time.Time) error {
	dir := filepath.Join(s.root, buildsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var errs []error
	for _, e := range entries {
		lg, err := s.get(logKey{build: true, id: e.Name()})
		if err != nil {
			continue
		}
		lg.mu.Lock()
		old := lg.writers == 0 && lg.newestModTime().Before(before)
		if old {
			lg.closeFile()
			lg.segs = nil
			errs = append(errs, os.RemoveAll(lg.dir))
		}
		lg.mu.Unlock()
	}
	return errors.Join(errs...)
}

type segment struct {
	seq  uint64
	size int64
}

func segmentName(seq uint64) string { return fmt.Sprintf("%016d.log", seq) }

// position is a byte offset in one segment; everything before it is
// history.
type position struct {
	seq uint64
	off int64
}

// serviceLog is one service's (or build's) log. mu guards every field; the
// segment files are append-only, so readers copy the segment list under
// the lock and read files without it.
type serviceLog struct {
	dir   string
	build bool

	mu        sync.Mutex
	segs      []segment // oldest first; the last one is active
	f         *os.File  // active segment, opened on the first write
	lastWrite time.Time
	subs      map[*subscriber]struct{}
	// Builds only: open writers, and done is closed once the last one
	// closes (or at load when the log is already complete).
	writers    int
	done       chan struct{}
	doneClosed bool
}

func (l *serviceLog) load() error {
	entries, err := os.ReadDir(l.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %s: %w", l.dir, err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		seq, err := strconv.ParseUint(strings.TrimSuffix(name, ".log"), 10, 64)
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		l.segs = append(l.segs, segment{seq: seq, size: info.Size()})
	}
	slices.SortFunc(l.segs, func(a, b segment) int { return int64Cmp(int64(a.seq), int64(b.seq)) })
	if l.build && len(l.segs) > 0 {
		// A build log on disk with nobody writing it is complete.
		l.closeDone()
	}
	return nil
}

func int64Cmp(a, b int64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func (l *serviceLog) closeDone() {
	if !l.doneClosed {
		close(l.done)
		l.doneClosed = true
	}
}

// end is the current end of the log. Callers hold mu.
func (l *serviceLog) end() position {
	if len(l.segs) == 0 {
		return position{}
	}
	last := l.segs[len(l.segs)-1]
	return position{seq: last.seq, off: last.size}
}

func (l *serviceLog) closeFile() {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
}

// append writes entries to the active segment, rotates, trims to the byte
// budget and wakes followers.
func (l *serviceLog) append(entries []*agentv1.LogEntry, ret Retention, now time.Time) error {
	buf := make([]byte, 0, 128*len(entries))
	for _, e := range entries {
		buf = appendEncoded(buf, e)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		if err := os.MkdirAll(l.dir, 0o750); err != nil {
			return fmt.Errorf("creating %s: %w", l.dir, err)
		}
		if len(l.segs) == 0 {
			l.segs = append(l.segs, segment{seq: 1})
		}
		active := &l.segs[len(l.segs)-1]
		f, err := os.OpenFile(filepath.Join(l.dir, segmentName(active.seq)), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o640)
		if err != nil {
			return fmt.Errorf("opening log segment: %w", err)
		}
		l.f = f
	}
	n, err := l.f.Write(buf)
	l.segs[len(l.segs)-1].size += int64(n)
	l.lastWrite = now
	if err != nil {
		return fmt.Errorf("writing log: %w", err)
	}
	if l.segs[len(l.segs)-1].size >= ret.segmentBytes() {
		l.closeFile()
		l.segs = append(l.segs, segment{seq: l.segs[len(l.segs)-1].seq + 1})
	}
	l.trimBytes(ret.MaxBytes)
	for s := range l.subs {
		s.push(entries)
	}
	return nil
}

// trimBytes drops the oldest segments while the log is over budget. The
// active segment always stays. Callers hold mu.
func (l *serviceLog) trimBytes(maxBytes int64) {
	var total int64
	for _, s := range l.segs {
		total += s.size
	}
	for total > maxBytes && len(l.segs) > 1 {
		old := l.segs[0]
		if err := os.Remove(filepath.Join(l.dir, segmentName(old.seq))); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return
		}
		total -= old.size
		l.segs = l.segs[1:]
	}
}

// pruneAge removes segments last written before cutoff.
func (l *serviceLog) pruneAge(cutoff time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for len(l.segs) > 0 {
		old := l.segs[0]
		path := filepath.Join(l.dir, segmentName(old.seq))
		info, err := os.Stat(path)
		if errors.Is(err, fs.ErrNotExist) {
			if len(l.segs) == 1 {
				return nil // a fresh active segment nobody wrote to yet
			}
			l.segs = l.segs[1:]
			continue
		}
		if err != nil {
			return err
		}
		if !info.ModTime().Before(cutoff) {
			return nil
		}
		if len(l.segs) == 1 {
			// The active segment itself is too old: start a fresh one.
			l.closeFile()
			l.segs = []segment{{seq: old.seq + 1}}
		} else {
			l.segs = l.segs[1:]
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (l *serviceLog) newestModTime() time.Time {
	var t time.Time
	for _, s := range l.segs {
		if info, err := os.Stat(filepath.Join(l.dir, segmentName(s.seq))); err == nil && info.ModTime().After(t) {
			t = info.ModTime()
		}
	}
	return t
}

// closeIfIdle closes the file of a log nobody wrote or followed for a
// while and reports whether it can be dropped from memory.
func (l *serviceLog) closeIfIdle(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.subs) > 0 || l.writers > 0 || now.Sub(l.lastWrite) < idleClose {
		return false
	}
	l.closeFile()
	return true
}

// snapshot copies the segments up to end (oldest first) with the bytes to
// read from each.
func (l *serviceLog) snapshot(end position) []segment {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []segment
	for _, s := range l.segs {
		if s.seq > end.seq {
			break
		}
		if s.seq == end.seq {
			s.size = min(s.size, end.off)
		}
		out = append(out, s)
	}
	return out
}

// readSegment reads the first size bytes of a segment. A segment removed
// by retention meanwhile reads as empty.
func (l *serviceLog) readSegment(s segment) ([]byte, error) {
	if s.size <= 0 {
		return nil, nil
	}
	f, err := os.Open(filepath.Join(l.dir, segmentName(s.seq)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, s.size)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf[:n], nil
}

// readTail returns the last n entries before end, oldest first.
func (l *serviceLog) readTail(n int, end position) ([]*agentv1.LogEntry, error) {
	if n <= 0 {
		return nil, nil
	}
	segs := l.snapshot(end)
	var out []*agentv1.LogEntry
	for i := len(segs) - 1; i >= 0 && len(out) < n; i-- {
		data, err := l.readSegment(segs[i])
		if err != nil {
			return nil, err
		}
		eachLineReverse(data, func(line []byte, _ int) bool {
			if r, ok := parseRecord(line); ok {
				out = append(out, r.entry())
			}
			return len(out) < n
		})
	}
	slices.Reverse(out)
	return out, nil
}

// readSince returns entries after since and before end, oldest first, at
// most limit (the newest ones).
func (l *serviceLog) readSince(since time.Time, end position, limit int) ([]*agentv1.LogEntry, error) {
	segs := l.snapshot(end)
	cutoff := since.UnixNano()
	var out []*agentv1.LogEntry
	stop := false
	for i := len(segs) - 1; i >= 0 && !stop; i-- {
		data, err := l.readSegment(segs[i])
		if err != nil {
			return nil, err
		}
		eachLineReverse(data, func(line []byte, _ int) bool {
			r, ok := parseRecord(line)
			if !ok {
				return true
			}
			if r.nanos <= cutoff || len(out) >= limit {
				stop = true
				return false
			}
			out = append(out, r.entry())
			return true
		})
	}
	slices.Reverse(out)
	return out, nil
}
