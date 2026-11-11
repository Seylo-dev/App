package volumes

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"

	"github.com/seylo-dev/app/go/internal/datadir"
)

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
)

// Transfer exports and imports volumes under a data dir.
type Transfer struct {
	Layout datadir.Layout
	// Running reports whether the service has running containers here;
	// nil skips the check.
	Running func(ctx context.Context, serviceID string) (bool, error)
}

// Export writes the volume of owner as .tar.gz to w and returns the
// uncompressed bytes archived.
func (t *Transfer) Export(ctx context.Context, owner, volume string, w io.Writer) (uint64, error) {
	dir, err := t.Layout.ServiceVolume(owner, volume)
	if err != nil {
		return 0, err
	}
	root, err := os.OpenRoot(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, fmt.Errorf("%w: %s", ErrNoVolume, volume)
	}
	if err != nil {
		return 0, fmt.Errorf("opening volume: %w", err)
	}
	defer root.Close()

	// Through os.Root with every opened file checked against its listing:
	// see WriteArchive. Hard links stay links on the target.
	total, err := writeArchive(ctx, root, w, ArchiveOptions{Level: gzip.BestSpeed, HardLinks: true})
	if err != nil {
		return total, fmt.Errorf("archiving volume: %w", err)
	}
	return total, nil
}

// Import unpacks a .tar.gz from r into owner's volume and returns the
// uncompressed bytes written. serviceID is the service being moved (for
// the running check).
func (t *Transfer) Import(ctx context.Context, serviceID, owner, volume string, replace bool, r io.Reader) (uint64, error) {
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
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, fmt.Errorf("opening volume: %w", err)
	}
	defer root.Close()
	if err := clearOrCheck(root, replace); err != nil {
		return 0, err
	}
	return Unpack(ctx, root, r, UnpackOptions{Owners: os.Geteuid() == 0})
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
