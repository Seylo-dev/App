package volumes

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// IncomingMarker is the file an import keeps in the services/<id> folder
// it fills. Its time is the import's last write.
const IncomingMarker = ".incoming"

// IncomingGrace is how long after an import's last write its folder counts
// as in use although no service here names it: a move or clone copies one
// volume after another and only then places the service on this node, and
// a copy the panel never finished must not be swept as an orphan's either.
const IncomingGrace = 24 * time.Hour

// IncomingAt is when an import last wrote into the services/<id> folder
// dir (zero: never, or no marker).
func IncomingAt(dir string) time.Time {
	st, err := os.Lstat(filepath.Join(dir, IncomingMarker))
	if err != nil || !st.Mode().IsRegular() {
		return time.Time{}
	}
	return st.ModTime()
}

// guard keeps imports and cleanup's removal of a services/<id> folder
// apart, by folder path: an import waits while the folder is removed, and
// a removal is skipped while an import writes.
var guard = struct {
	sync.Mutex
	cond      *sync.Cond
	importing map[string]int
	removing  map[string]bool
}{importing: map[string]int{}, removing: map[string]bool{}}

func init() { guard.cond = sync.NewCond(&guard.Mutex) }

// beginImport marks dir as filled by an import and touches its marker. The
// returned func touches the marker again and ends the mark.
func beginImport(dir string) (func(), error) {
	guard.Lock()
	for guard.removing[dir] {
		guard.cond.Wait()
	}
	guard.importing[dir]++
	guard.Unlock()
	end := func() {
		_ = touchIncoming(dir)
		guard.Lock()
		if guard.importing[dir]--; guard.importing[dir] <= 0 {
			delete(guard.importing, dir)
		}
		guard.cond.Broadcast()
		guard.Unlock()
	}
	if err := touchIncoming(dir); err != nil {
		end()
		return nil, err
	}
	return end, nil
}

func touchIncoming(dir string) error {
	// A services/<id>/ folder, and services/ itself, are root's only.
	if err := os.MkdirAll(dir, datadir.PrivateDirMode); err != nil {
		return err
	}
	name := filepath.Join(dir, IncomingMarker)
	now := time.Now()
	if err := os.Chtimes(name, now, now); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.WriteFile(name, nil, 0o600)
}

// ErrIncoming is RemoveServiceDir refusing a folder an import fills or
// filled within IncomingGrace.
var ErrIncoming = errors.New("a volume copy is writing into it or wrote into it in the last 24 hours")

// ErrInUse is RemoveServiceDir refusing a folder whose service stillOrphan
// says is back.
var ErrInUse = errors.New("its service is on this node again")

// RemoveServiceDir deletes the services/<id> folder dir for cleanup. It
// refuses (ErrIncoming) while an import writes into it or when one wrote
// within IncomingGrace of now, and (ErrInUse) when stillOrphan, asked
// right before the removal, says the folder is in use again. Imports into
// the folder wait until the removal is done.
func RemoveServiceDir(dir string, now time.Time, stillOrphan func() bool) error {
	guard.Lock()
	if guard.importing[dir] > 0 || guard.removing[dir] {
		guard.Unlock()
		return ErrIncoming
	}
	guard.removing[dir] = true
	guard.Unlock()
	defer func() {
		guard.Lock()
		delete(guard.removing, dir)
		guard.cond.Broadcast()
		guard.Unlock()
	}()
	if at := IncomingAt(dir); !at.IsZero() && now.Sub(at) < IncomingGrace {
		return ErrIncoming
	}
	if stillOrphan != nil && !stillOrphan() {
		return ErrInUse
	}
	return os.RemoveAll(dir)
}
