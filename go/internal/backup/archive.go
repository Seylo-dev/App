package backup

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
	"slices"
	"strings"

	"github.com/seylo-dev/app/go/internal/volumes"
)

// writeArchive writes dir as a gzipped tar to w: regular files, folders
// and symlinks with their modes, owners and times (numeric ids only).
// Symlinks are stored, never followed; sockets, devices and pipes are
// skipped. Hard links become separate copies. dir is a live volume a
// container may change while we read it as root, so the walk goes through
// os.Root and refuses a file swapped for a symlink mid-walk
// (volumes.WriteArchive); opening by path would let a container make the
// agent archive any host file.
func writeArchive(ctx context.Context, dir string, w io.Writer) error {
	_, err := volumes.WriteArchive(ctx, dir, w, volumes.ArchiveOptions{Level: gzip.DefaultCompression, DotPrefix: true})
	return err
}

// extractArchive unpacks a gzipped tar written by writeArchive into dir,
// which must exist and should be empty. Every path is resolved inside dir
// with os.Root, so entries like "../x" or symlinks pointing outside cannot
// write anywhere else. Owners are restored when running as root.
func extractArchive(ctx context.Context, r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("reading archive: %w", err)
	}
	defer gz.Close()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	asRoot := os.Geteuid() == 0
	type dirMeta struct {
		name string
		hdr  *tar.Header
	}
	var dirs []dirMeta

	tr := tar.NewReader(gz)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("reading archive: %w", err)
		}
		name, err := entryName(hdr.Name)
		if err != nil {
			return err
		}
		mode := fs.FileMode(hdr.Mode).Perm() | fs.FileMode(hdr.Mode)&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if name != "." {
				if err := root.MkdirAll(name, 0o700); err != nil {
					return err
				}
			}
			dirs = append(dirs, dirMeta{name, hdr})
			continue
		case tar.TypeReg:
			if err := mkParent(root, name); err != nil {
				return err
			}
			f, err := root.OpenFile(name, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			_, cerr := io.CopyN(f, tr, hdr.Size)
			if err := errors.Join(cerr, f.Close()); err != nil {
				return fmt.Errorf("extracting %s: %w", name, err)
			}
			if err := root.Chmod(name, mode); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := mkParent(root, name); err != nil {
				return err
			}
			if err := root.Symlink(hdr.Linkname, name); err != nil {
				return err
			}
		case tar.TypeLink:
			target, err := entryName(hdr.Linkname)
			if err != nil {
				return err
			}
			if err := mkParent(root, name); err != nil {
				return err
			}
			if err := root.Link(target, name); err != nil {
				return err
			}
			continue
		default:
			continue
		}
		if asRoot {
			if err := root.Lchown(name, hdr.Uid, hdr.Gid); err != nil {
				return err
			}
		}
		if hdr.Typeflag == tar.TypeReg {
			_ = root.Chtimes(name, hdr.ModTime, hdr.ModTime)
		}
	}
	// Folders last and deepest first, so a read-only folder does not block
	// writing its children and child writes do not change parent times.
	slices.Reverse(dirs)
	for _, d := range dirs {
		mode := fs.FileMode(d.hdr.Mode).Perm() | fs.FileMode(d.hdr.Mode)&(fs.ModeSetuid|fs.ModeSetgid|fs.ModeSticky)
		if err := root.Chmod(d.name, mode); err != nil {
			return err
		}
		if asRoot {
			if err := root.Lchown(d.name, d.hdr.Uid, d.hdr.Gid); err != nil {
				return err
			}
		}
		_ = root.Chtimes(d.name, d.hdr.ModTime, d.hdr.ModTime)
	}
	return nil
}

// entryName cleans an archive path and refuses absolute paths and "..".
func entryName(raw string) (string, error) {
	n := strings.TrimPrefix(path.Clean("/"+raw), "/")
	if n == "" {
		return ".", nil
	}
	for _, part := range strings.Split(strings.TrimSuffix(raw, "/"), "/") {
		if part == ".." {
			return "", fmt.Errorf("%w: archive entry %q leaves the folder", ErrBadArchive, raw)
		}
	}
	return n, nil
}

func mkParent(root *os.Root, name string) error {
	if dir := path.Dir(name); dir != "." {
		return root.MkdirAll(dir, 0o755)
	}
	return nil
}

// ErrBadArchive means a restore archive is malformed or malicious.
var ErrBadArchive = errors.New("invalid backup archive")
