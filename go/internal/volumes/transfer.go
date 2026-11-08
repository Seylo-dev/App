package volumes

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"

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
	dir, err := t.Layout.ServiceVolume(owner, volume)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, fmt.Errorf("creating volume folder: %w", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, fmt.Errorf("opening volume: %w", err)
	}
	defer root.Close()
	if err := clearOrCheck(root, replace); err != nil {
		return 0, err
	}

	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadArchive, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	asRoot := os.Geteuid() == 0
	var total uint64
	type dirMeta struct {
		name  string
		mode  fs.FileMode
		mtime time.Time
	}
	var dirs []dirMeta
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return total, fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
		name, ok := cleanName(hdr.Name)
		if !ok {
			return total, fmt.Errorf("%w: bad path %q", ErrBadArchive, hdr.Name)
		}
		if name == "." {
			continue
		}
		mode := ArchiveMode(hdr)
		if parent := path.Dir(name); parent != "." {
			if err := root.MkdirAll(parent, 0o755); err != nil {
				return total, fmt.Errorf("creating %s: %w", parent, err)
			}
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o755); err != nil {
				return total, fmt.Errorf("creating %s: %w", name, err)
			}
			dirs = append(dirs, dirMeta{name, mode, hdr.ModTime})
		case tar.TypeReg:
			_ = root.Remove(name) // replace a link or an older file, never write through one
			f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return total, fmt.Errorf("creating %s: %w", name, err)
			}
			n, err := io.Copy(f, tr)
			total += uint64(n)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return total, fmt.Errorf("writing %s: %w", name, err)
			}
			if err := root.Chmod(name, mode); err != nil {
				return total, err
			}
			_ = root.Chtimes(name, hdr.ModTime, hdr.ModTime)
		case tar.TypeSymlink:
			_ = root.Remove(name)
			if err := root.Symlink(hdr.Linkname, name); err != nil {
				return total, fmt.Errorf("creating link %s: %w", name, err)
			}
		case tar.TypeLink:
			target, ok := cleanName(hdr.Linkname)
			if !ok || target == "." {
				return total, fmt.Errorf("%w: bad link target %q", ErrBadArchive, hdr.Linkname)
			}
			_ = root.Remove(name)
			if err := root.Link(target, name); err != nil {
				return total, fmt.Errorf("creating hard link %s: %w", name, err)
			}
		default:
			continue
		}
		if asRoot {
			if err := root.Lchown(name, hdr.Uid, hdr.Gid); err != nil {
				return total, fmt.Errorf("setting owner of %s: %w", name, err)
			}
		}
	}
	// Directory modes and times last, so writing into them worked and
	// their mtimes are not bumped by the files.
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		if err := root.Chmod(d.name, d.mode); err != nil {
			return total, err
		}
		_ = root.Chtimes(d.name, d.mtime, d.mtime)
	}
	return total, nil
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
