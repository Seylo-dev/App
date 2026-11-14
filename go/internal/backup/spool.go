package backup

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/internal/volumes"
)

// spool is the pipe between a backup's producer (a dump or a volume
// archive) and the store's Put. Unlike io.Pipe, a write does not wait for
// the reader while the spool has room. The stores upload a part at a time
// (SignedStore reads 32 MiB, then presigns, sends and retries it before it
// reads on; minio-go does the same), and while a part uploaded nothing
// drained the dump: the database closed the connection of a client that
// stopped reading (MariaDB's net_write_timeout, Redis's repl-timeout for
// redis-cli --rdb).
//
// What the upload has not taken yet stays here: up to memLimit in memory,
// then, when the backup may use disk, in files of segSize in dir, each
// removed from the folder right after it is created (its space comes back
// with the last descriptor, also when the agent dies; Local.Run also
// empties dir when it starts) and closed as soon as the reader is past it.
// Bytes come out in the order they went in: memory first, and once a file
// is in use every write goes to the files until the reader has caught up.
//
// The files are bounded twice: at most maxSegs of them (spoolDiskMax), and
// none that would leave less free on the filesystem than spoolFloor. With
// no room the writer waits for the reader, as with a pipe, whatever it
// produces: the spool never fails a backup by itself. A wait of holdMin or
// more is recorded (lastHold), so a dump its database dropped meanwhile
// says why (connectionLostHint).
type spool struct {
	dir      string
	memLimit int
	segSize  int64
	// maxSegs caps the files; 0 keeps the spool in memory.
	maxSegs int
	// space reports the free and total bytes of the filesystem holding
	// dir; ok false skips the check.
	space   func(dir string) (free, total uint64, ok bool)
	holdMin time.Duration
	now     func() time.Time

	wmu sync.Mutex // one Write at a time
	rmu sync.Mutex // one Read at a time

	mu   sync.Mutex
	cond *sync.Cond
	// mem holds chunks, oldest first; memOff is the read offset in mem[0]
	// and memBytes what is unread. Everything in mem comes before
	// everything in segs.
	mem      [][]byte
	memOff   int
	memBytes int
	segs     []*spoolSeg
	// released counts files the reader finished (wakes a waiting writer).
	released int
	// reading: a Read is between its ReadAt and taking mu back, so a
	// CloseRead leaves the files for it to close.
	reading bool
	// werr: the writer closed (io.EOF when the stream is complete); rerr:
	// the reader closed.
	werr, rerr error
	// lastHold is the last wait for room of holdMin or more.
	lastHold spoolHold
}

// holdReason says why the writer had no room.
type holdReason int

const (
	// holdMemory: the backup keeps to memory (spoolsToDisk).
	holdMemory holdReason = iota + 1
	// holdCeiling: the files hold spoolDiskMax.
	holdCeiling
	// holdFloor: another file would leave less than spoolFloor free.
	holdFloor
)

// spoolHold is one wait of the writer for the reader.
type spoolHold struct {
	why holdReason
	// held is what the spool held when the wait began.
	held int64
	dur  time.Duration
	end  time.Time
}

// what says why the dump waited, for an error message.
func (h *spoolHold) what() string {
	if h.why == holdCeiling {
		return fmt.Sprintf("the upload fell behind the dump by more than %s, the most one backup holds on the node", sizeText(h.held))
	}
	return fmt.Sprintf("the upload fell behind the dump by more than %s and the node has no room to hold it (backups leave 15%% of its disk and 10 GiB free)", sizeText(h.held))
}

// spoolSeg is one spool file: w bytes written, r of them read.
type spoolSeg struct {
	f    *os.File
	w, r int64
}

const (
	// spoolMemory is what a backup holds in memory before it spools to
	// disk: next to the part a store buffers (32 MiB), this keeps memory
	// per backup bounded as before.
	spoolMemory = 16 << 20
	// spoolSegment is the size of one spool file, the unit in which disk
	// space is taken and given back: a store's part (32 MiB), so at the
	// ceiling every part the store takes frees a file.
	spoolSegment = 32 << 20
	// spoolDiskMax is the most one backup's files take on disk. Beyond it
	// the dump waits for the upload, so a slow uplink never fills a node
	// with a large backup.
	spoolDiskMax = 4 << 30
	// spoolChunk is the size of one memory chunk.
	spoolChunk = 256 << 10
	// spoolPrefix starts every spool file's name.
	spoolPrefix = "spool-"
	// spoolHoldMin is the shortest wait for room that is recorded: no
	// server drops a client in less.
	spoolHoldMin = time.Second
	// spoolHoldRecent: a dump that fails this soon after a recorded wait
	// is taken to have been dropped during it. A dropped client notices
	// as soon as it reads again, right after the wait.
	spoolHoldRecent = 15 * time.Second
)

// spoolFloor is what a spool file must leave free on a filesystem of total
// bytes: 15% of it and at least 10 GiB, the line under which the node's
// disk check warns (nodecheck diskResult). A backup never turns that check
// yellow or red, nor sets off a disk-triggered cleanup at the usual lines,
// and it stays above volumes.FreeFloor (at most 5 GiB), what imports leave.
func spoolFloor(total uint64) uint64 { return max(10<<30, total/100*15) }

// newSpool is a spool whose files go to dir, or one in memory alone
// without disk.
func newSpool(dir string, disk bool) *spool {
	s := &spool{dir: dir, memLimit: spoolMemory, segSize: spoolSegment, space: volumes.DiskSpace,
		holdMin: spoolHoldMin, now: time.Now}
	if disk {
		s.maxSegs = spoolDiskMax / spoolSegment
	}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// sizeText writes n bytes in decimal units ("1.2 GB").
func sizeText(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d bytes", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "kMGTPE"[exp])
}

// held is what the spool holds unread. mu held.
func (s *spool) held() int64 {
	n := int64(s.memBytes)
	for _, seg := range s.segs {
		n += seg.w - seg.r
	}
	return n
}

// Write implements io.Writer. It waits for disk writes and, when the spool
// has no room, for the reader; it fails once the reader closed.
func (s *spool) Write(p []byte) (int, error) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	n := 0
	for len(p) > 0 {
		s.mu.Lock()
		if s.rerr != nil {
			err := s.rerr
			s.mu.Unlock()
			return n, err
		}
		if s.werr != nil {
			s.mu.Unlock()
			return n, io.ErrClosedPipe
		}
		if len(s.segs) == 0 && s.memBytes < s.memLimit {
			k := s.memWrite(p)
			s.cond.Broadcast()
			s.mu.Unlock()
			n += k
			p = p[k:]
			continue
		}
		var seg *spoolSeg
		if last := len(s.segs) - 1; last >= 0 && s.segs[last].w < s.segSize {
			seg = s.segs[last]
		}
		// Only this writer adds files, so the count can only drop.
		files, mark := len(s.segs), s.released
		s.mu.Unlock()
		if seg == nil {
			var why holdReason
			var err error
			if seg, why, err = s.newSeg(files); err != nil {
				return n, err
			}
			if seg == nil {
				s.hold(why, mark)
				continue
			}
		}
		// seg.w changes only here, under wmu.
		k := min(int64(len(p)), s.segSize-seg.w)
		m, err := seg.f.WriteAt(p[:k], seg.w)
		s.mu.Lock()
		seg.w += int64(m)
		s.cond.Broadcast()
		rerr := s.rerr
		s.mu.Unlock()
		n += m
		p = p[m:]
		if rerr != nil {
			return n, rerr
		}
		if err != nil {
			return n, fmt.Errorf("spooling the backup to %s: %w", s.dir, err)
		}
	}
	return n, nil
}

// memWrite copies what fits of p into memory. mu held.
func (s *spool) memWrite(p []byte) int {
	n := 0
	for len(p) > 0 && s.memBytes < s.memLimit {
		last := len(s.mem) - 1
		if last < 0 || len(s.mem[last]) == cap(s.mem[last]) {
			s.mem = append(s.mem, make([]byte, 0, spoolChunk))
			last++
		}
		c := s.mem[last]
		k := min(len(p), cap(c)-len(c), s.memLimit-s.memBytes)
		s.mem[last] = append(c, p[:k]...)
		s.memBytes += k
		n += k
		p = p[k:]
	}
	return n
}

// memRead moves the oldest bytes in memory to p. mu held, memBytes > 0.
func (s *spool) memRead(p []byte) int {
	c := s.mem[0]
	n := copy(p, c[s.memOff:])
	s.memOff += n
	s.memBytes -= n
	// A drained chunk goes, unless it is the last one with room the
	// writer still fills.
	if s.memOff == len(c) && (len(s.mem) > 1 || len(c) == cap(c)) {
		s.mem[0] = nil
		s.mem = s.mem[1:]
		s.memOff = 0
	}
	return n
}

// newSeg starts a spool file after files others. Without room for it (no
// disk for this backup, the ceiling, the floor) it returns nil and why.
func (s *spool) newSeg(files int) (*spoolSeg, holdReason, error) {
	switch {
	case s.maxSegs == 0:
		return nil, holdMemory, nil
	case files >= s.maxSegs:
		return nil, holdCeiling, nil
	}
	// The folder first: statfs on a folder that is not there yet fails,
	// which would skip the check.
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return nil, 0, fmt.Errorf("spooling the backup: %w", err)
	}
	if free, total, ok := s.space(s.dir); ok && free < uint64(s.segSize)+spoolFloor(total) {
		return nil, holdFloor, nil
	}
	f, err := os.CreateTemp(s.dir, spoolPrefix+"*")
	if err != nil {
		return nil, 0, fmt.Errorf("spooling the backup: %w", err)
	}
	// Gone from the folder now; the space comes back with the descriptor.
	_ = os.Remove(f.Name())
	seg := &spoolSeg{f: f}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rerr != nil {
		f.Close()
		return nil, 0, s.rerr
	}
	s.segs = append(s.segs, seg)
	return seg, 0, nil
}

// hold waits until the reader has made room since released was mark (a
// file done, or room in memory with no files left) or closed, and records
// a long wait.
func (s *spool) hold(why holdReason, mark int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	start, held := s.now(), s.held()
	for s.rerr == nil && s.released == mark && (len(s.segs) > 0 || s.memBytes >= s.memLimit) {
		s.cond.Wait()
	}
	if end := s.now(); end.Sub(start) >= s.holdMin {
		s.lastHold = spoolHold{why: why, held: held, dur: end.Sub(start), end: end}
	}
}

// recentHold is the writer's last recorded wait when the backup could have
// used disk and the wait ended less than spoolHoldRecent ago: a database
// that drops a client which stops reading may have dropped the dump then.
// nil otherwise, also for a nil spool.
func (s *spool) recentHold() *spoolHold {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.lastHold
	if h.dur == 0 || h.why == holdMemory || s.now().Sub(h.end) > spoolHoldRecent {
		return nil
	}
	return &h
}

// Read implements io.Reader: the oldest bytes, waiting for the writer when
// there are none; io.EOF after the last byte of a stream the writer closed
// with nil, the writer's error right away when it closed with one.
func (s *spool) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	s.rmu.Lock()
	defer s.rmu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		switch {
		case s.rerr != nil:
			return 0, io.ErrClosedPipe
		case s.werr != nil && s.werr != io.EOF:
			return 0, s.werr
		case s.memBytes > 0:
			n := s.memRead(p)
			s.cond.Broadcast()
			return n, nil
		case len(s.segs) > 0 && s.segs[0].r < s.segs[0].w:
			return s.segRead(p)
		case s.werr == io.EOF:
			return 0, io.EOF
		}
		s.cond.Wait()
	}
}

// segRead reads from the oldest file without holding mu during the read.
// mu held.
func (s *spool) segRead(p []byte) (int, error) {
	seg := s.segs[0]
	k := min(int64(len(p)), seg.w-seg.r)
	off := seg.r
	s.reading = true
	s.mu.Unlock()
	n, err := seg.f.ReadAt(p[:k], off)
	s.mu.Lock()
	s.reading = false
	if s.rerr != nil {
		// Closed meanwhile: the files are this read's to close.
		s.closeSegs()
		return 0, io.ErrClosedPipe
	}
	seg.r += int64(n)
	if seg.r == s.segSize {
		// Full and read: the writer is past it.
		seg.f.Close()
		s.segs[0] = nil
		s.segs = s.segs[1:]
		s.released++
	}
	s.cond.Broadcast()
	if int64(n) < k {
		if err == nil || errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return n, fmt.Errorf("reading the backup spool: %w", err)
	}
	return n, nil
}

// CloseWrite ends the stream. nil after the last byte: the reader gets what
// is spooled, then io.EOF. An error (the producer failed): the reader gets
// it on its next Read.
func (s *spool) CloseWrite(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.werr != nil {
		return
	}
	if err == nil {
		err = io.EOF
	}
	s.werr = err
	s.cond.Broadcast()
}

// CloseRead ends the reading side (the upload finished or failed): writes
// fail with err from now on (io.ErrClosedPipe for nil) and the spool lets
// go of its memory and files.
func (s *spool) CloseRead(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rerr != nil {
		return
	}
	if err == nil {
		err = io.ErrClosedPipe
	}
	s.rerr = err
	s.mem, s.memOff, s.memBytes = nil, 0, 0
	if !s.reading {
		s.closeSegs()
	}
	s.cond.Broadcast()
}

// closeSegs closes every spool file. mu held.
func (s *spool) closeSegs() {
	for _, seg := range s.segs {
		seg.f.Close()
	}
	s.segs = nil
}

// clearSpoolDir deletes spool files a previous agent left in dir (it died
// between creating one and removing its name).
func clearSpoolDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), spoolPrefix) {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}
