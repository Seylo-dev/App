package volumes

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path"
	"time"
)

// ErrTooLarge means an archive holds more file bytes than the room it was
// given (UnpackOptions.Budget).
var ErrTooLarge = errors.New("the archive is larger than the space for it")

// UnpackOptions shape what Unpack accepts and how it writes.
type UnpackOptions struct {
	// Owners gives entries their archived uid and gid. Only root can, so
	// callers pass os.Geteuid() == 0.
	Owners bool
	// RegularOnly refuses every entry but regular files and folders:
	// symlinks, hard links, devices and pipes fail the unpack instead of
	// being created or skipped. For data that never holds them (the
	// panel's data folder), where one would mean a broken sender.
	RegularOnly bool
	// Private writes files 0600 and folders 0700 whatever the archive says.
	Private bool
	// Budget caps the file bytes written; 0 is no cap. A file that would
	// pass it fails the unpack with ErrTooLarge before it is written.
	Budget uint64
	// CheckEnd reads the gzip stream to its end after the tar archive, so
	// gzip's checksum is checked, and refuses data after the archive
	// (other than the zeros tar pads with).
	CheckEnd bool
	// File, when set, is asked before each regular file is written, with
	// its clean name and archived size; an error stops the unpack.
	File func(name string, size int64) error
	// Written, when set, gets each regular file once it is written: its
	// clean name, the bytes written and their SHA-256. An error stops the
	// unpack.
	Written func(name string, size int64, sum [sha256.Size]byte) error
}

// Unpack writes a .tar.gz from r into root and returns the file bytes
// written. Names are cleaned and must stay inside root (absolute paths and
// ".." are refused), and every write goes through root, so neither a link
// in the archive nor one already in the folder can lead outside it. A
// regular file replaces whatever had its name, it never writes through it.
// Folder modes and times are set last.
func Unpack(ctx context.Context, root *os.Root, r io.Reader, opts UnpackOptions) (uint64, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", ErrBadArchive, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total uint64
	type dirMeta struct {
		name  string
		mode  fs.FileMode
		mtime time.Time
	}
	var dirs []dirMeta
	var sum hash.Hash
	if opts.Written != nil {
		sum = sha256.New()
	}
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
		if hdr.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		if opts.RegularOnly && hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeDir {
			return total, fmt.Errorf("%w: %s is not a regular file or a folder", ErrBadArchive, hdr.Name)
		}
		if name == "." {
			continue
		}
		// mode is what the entry ends with; folders are made with makeMode
		// so the files after them can be written.
		mode, makeMode := ArchiveMode(hdr), fs.FileMode(0o755)
		if opts.Private {
			mode, makeMode = 0o600, 0o700
			if hdr.Typeflag == tar.TypeDir {
				mode = 0o700
			}
		}
		if parent := path.Dir(name); parent != "." {
			if err := root.MkdirAll(parent, makeMode); err != nil {
				return total, fmt.Errorf("creating %s: %w", parent, err)
			}
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, makeMode); err != nil {
				return total, fmt.Errorf("creating %s: %w", name, err)
			}
			dirs = append(dirs, dirMeta{name, mode, hdr.ModTime})
		case tar.TypeReg:
			if hdr.Size < 0 || (opts.Budget > 0 && total+uint64(hdr.Size) > opts.Budget) {
				return total, fmt.Errorf("%w: %s", ErrTooLarge, name)
			}
			if opts.File != nil {
				if err := opts.File(name, hdr.Size); err != nil {
					return total, err
				}
			}
			_ = root.Remove(name) // replace a link or an older file, never write through one
			f, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return total, fmt.Errorf("creating %s: %w", name, err)
			}
			var w io.Writer = f
			if sum != nil {
				sum.Reset()
				w = io.MultiWriter(f, sum)
			}
			n, err := io.Copy(w, tr)
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
			if opts.Written != nil {
				var digest [sha256.Size]byte
				sum.Sum(digest[:0])
				if err := opts.Written(name, n, digest); err != nil {
					return total, err
				}
			}
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
		if opts.Owners {
			if err := root.Lchown(name, hdr.Uid, hdr.Gid); err != nil {
				return total, fmt.Errorf("setting owner of %s: %w", name, err)
			}
		}
	}
	if opts.CheckEnd {
		if err := readToEnd(gz); err != nil {
			return total, err
		}
	}
	// Folder modes and times last, so writing into them worked and their
	// mtimes are not bumped by the files.
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		if err := root.Chmod(d.name, d.mode); err != nil {
			return total, err
		}
		_ = root.Chtimes(d.name, d.mtime, d.mtime)
	}
	return total, nil
}

// readToEnd reads what follows the tar archive in the gzip stream: only
// the zeros tar pads its last record with may come, and reaching the end
// makes gzip check its CRC and size.
func readToEnd(gz io.Reader) error {
	buf := make([]byte, 32<<10)
	for {
		n, err := gz.Read(buf)
		for _, b := range buf[:n] {
			if b != 0 {
				return fmt.Errorf("%w: data after the end of the archive", ErrBadArchive)
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
	}
}
