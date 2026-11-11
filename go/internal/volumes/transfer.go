package volumes

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/seylo-dev/app/go/internal/datadir"
)

// ImportLimitsCapability is advertised by agents that honour
// ImportVolumeRequest's max_bytes, max_entries and sha256 (ImportOptions).
// The panel sends data from an uploaded export file only to them: an older
// agent would ignore the limits.
const ImportLimitsCapability = "volume.import-limits.v1"

// Errors callers map to statuses.
var (
	// ErrNotEmpty: importing into a volume that has files, without replace.
	ErrNotEmpty = errors.New("the volume is not empty")
	// ErrRunning: importing while the service runs on this node.
	ErrRunning = errors.New("the service is running on this node")
	// ErrNoVolume: exporting a volume that does not exist here.
	ErrNoVolume = errors.New("the volume does not exist on this node")
	// ErrBadArchive: the stream is not a valid .tar.gz.
	ErrBadArchive = errors.New("invalid volume archive")
	// ErrNoSpace: the data folder has less free space than the import may
	// need (ImportOptions.MaxBytes plus FreeFloor).
	ErrNoSpace = errors.New("not enough free space on this node for the volume")
	// ErrChecksum: the stream's SHA-256 is not ImportOptions.SHA256.
	ErrChecksum = errors.New("the volume archive does not match its checksum")
)

// ImportOptions shape an import. The limits are for data from outside the
// fleet (an uploaded export file); with any of them set, an import that
// fails after it started writing empties the volume, so no half import
// stays behind.
type ImportOptions struct {
	// Replace deletes what is in the volume first; without it a non-empty
	// volume is refused (ErrNotEmpty).
	Replace bool
	// MaxBytes caps the file bytes written (UnpackOptions.Budget) and asks
	// for that much free space plus FreeFloor up front; 0 is no cap.
	MaxBytes uint64
	// MaxEntries caps the archive's entries (UnpackOptions.MaxEntries).
	MaxEntries uint64
	// SHA256 is the lower-case hex hash the whole stream must have.
	SHA256 string
}

// Limited reports whether any limit is set (data from outside the fleet).
func (o ImportOptions) Limited() bool { return o.MaxBytes > 0 || o.MaxEntries > 0 || o.SHA256 != "" }

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// FreeFloor is the space an import leaves free on a filesystem of total
// bytes: a tenth of it, at least 1 GiB and at most 5 GiB, so one import
// cannot fill a disk other services share.
func FreeFloor(total uint64) uint64 {
	return min(max(total/10, 1<<30), 5<<30)
}

// Transfer exports and imports volumes under a data dir.
type Transfer struct {
	Layout datadir.Layout
	// Running reports whether the service has running containers here;
	// nil skips the check.
	Running func(ctx context.Context, serviceID string) (bool, error)
	// Space reports the free and total bytes of the filesystem holding dir;
	// nil reads them with statfs. Tests replace it.
	Space func(dir string) (free, total uint64, ok bool)
}

// Export writes the volume of owner as .tar.gz to w and returns the
// uncompressed file bytes and the entries archived.
func (t *Transfer) Export(ctx context.Context, owner, volume string, w io.Writer) (Archived, error) {
	dir, err := t.Layout.ServiceVolume(owner, volume)
	if err != nil {
		return Archived{}, err
	}
	root, err := os.OpenRoot(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return Archived{}, fmt.Errorf("%w: %s", ErrNoVolume, volume)
	}
	if err != nil {
		return Archived{}, fmt.Errorf("opening volume: %w", err)
	}
	defer root.Close()

	// Through os.Root with every opened file checked against its listing:
	// see WriteArchive. Hard links stay links on the target.
	got, err := writeArchive(ctx, root, w, ArchiveOptions{Level: gzip.BestSpeed, HardLinks: true})
	if err != nil {
		return got, fmt.Errorf("archiving volume: %w", err)
	}
	return got, nil
}

// Import unpacks a .tar.gz from r into owner's volume and returns the
// uncompressed bytes written. serviceID is the service being moved (for
// the running check). Imports into one volume run one after another: a
// second one waits until the first has ended, emptying the volume after a
// failure included, or until its own ctx ends.
func (t *Transfer) Import(ctx context.Context, serviceID, owner, volume string, opts ImportOptions, r io.Reader) (uint64, error) {
	if opts.SHA256 != "" && !sha256Hex.MatchString(opts.SHA256) {
		return 0, fmt.Errorf("%w: the checksum is not a lower-case hex SHA-256", ErrBadArchive)
	}
	if t.Running != nil {
		running, err := t.Running(ctx, serviceID)
		if err != nil {
			return 0, err
		}
		if running {
			return 0, ErrRunning
		}
	}
	// Until the panel places the service here, nothing in the desired
	// state names this folder: the marker keeps cleanup's hands off it.
	serviceDir, err := t.Layout.ServiceDir(owner)
	if err != nil {
		return 0, err
	}
	end, err := beginImport(serviceDir)
	if err != nil {
		return 0, fmt.Errorf("marking the service folder: %w", err)
	}
	defer end()
	// Inside services/<owner>/, which only root may enter.
	dir, err := t.Layout.MakeServiceVolume(owner, volume)
	if err != nil {
		return 0, err
	}
	// One import at a time per volume, its cleanup included: an upload
	// that starts over waits until the cancelled one has emptied it.
	unlock, err := lockVolume(ctx, dir)
	if err != nil {
		return 0, err
	}
	defer unlock()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, fmt.Errorf("opening volume: %w", err)
	}
	defer root.Close()
	if opts.MaxBytes > 0 {
		space := t.Space
		if space == nil {
			space = diskSpace
		}
		if free, total, ok := space(dir); ok && free < opts.MaxBytes+FreeFloor(total) {
			return 0, fmt.Errorf("%w: it may need %d bytes and %d must stay free, %d are", ErrNoSpace, opts.MaxBytes, FreeFloor(total), free)
		}
	}
	if err := clearOrCheck(root, opts.Replace); err != nil {
		return 0, err
	}
	var sum hash.Hash
	if opts.SHA256 != "" {
		sum = sha256.New()
		r = io.TeeReader(r, sum)
	}
	n, err := Unpack(ctx, root, r, UnpackOptions{
		Owners:     os.Geteuid() == 0,
		Budget:     opts.MaxBytes,
		MaxEntries: opts.MaxEntries,
		CheckEnd:   opts.Limited(),
	})
	if err == nil && sum != nil {
		// Anything after the gzip stream counts too: the hash is of every byte sent.
		if _, err = io.Copy(io.Discard, r); err == nil && hex.EncodeToString(sum.Sum(nil)) != opts.SHA256 {
			err = ErrChecksum
		}
	}
	if err != nil && opts.Limited() {
		// No half import from outside stays: the volume is left empty.
		if cerr := clearOrCheck(root, true); cerr != nil {
			return n, errors.Join(err, cerr)
		}
	}
	return n, err
}

// cleanName turns an archive path into a clean relative path, refusing
// anything that leaves the root.
func cleanName(name string) (string, bool) {
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", false
	}
	c := path.Clean(name)
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", false
	}
	return c, true
}

// clearOrCheck empties the volume (replace) or makes sure it is empty.
func clearOrCheck(root *os.Root, replace bool) error {
	f, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	if !replace {
		return ErrNotEmpty
	}
	for _, e := range entries {
		if err := root.RemoveAll(e.Name()); err != nil {
			return fmt.Errorf("clearing volume: %w", err)
		}
	}
	return nil
}
