package fs

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Extraction limits against archive bombs.
const (
	maxArchiveEntries = 200000
	// diskReserve is the share of free space an extraction leaves alone.
	diskReserve = 0.02
)

// Archive packs paths into destination (tar.gz by default, or zip). Entry
// names are relative to each path's folder, so packing "site/public"
// yields "public/...". Symlinks are stored as links, never followed.
func (f *rootFS) Archive(ctx context.Context, paths []string, destination string, format agentv1.ArchiveFormat) (*agentv1.FileInfo, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("%w: nothing to archive", ErrInvalidPath)
	}
	var rels []string
	for _, p := range paths {
		rel, err := clean(p)
		if err != nil {
			return nil, err
		}
		if _, err := f.root.Lstat(rel); err != nil {
			return nil, wrap(err)
		}
		rels = append(rels, rel)
	}
	up, err := f.Create(ctx, &agentv1.FsWriteRequest{Path: destination, Mode: 0o644})
	if err != nil {
		return nil, err
	}
	u := up.(*upload)
	skip := u.tmp // never pack the archive into itself
	bw := bufio.NewWriterSize(u, 256<<10)
	var werr error
	if format == agentv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP {
		werr = f.writeZip(ctx, bw, rels, skip)
	} else {
		werr = f.writeTarGz(ctx, bw, rels, skip)
	}
	if werr == nil {
		werr = bw.Flush()
	}
	if werr != nil {
		_ = up.Abort()
		return nil, werr
	}
	return up.Commit()
}

// walk visits rel and everything below it without following symlinks.
// fn gets the entry's path relative to the root and its archive name.
func (f *rootFS) walk(ctx context.Context, rel, skip string, fn func(p, name string, fi iofs.FileInfo) error) error {
	base := path.Dir(rel)
	return iofs.WalkDir(f.root.FS(), rel, func(p string, d iofs.DirEntry, err error) error {
		if err != nil {
			return wrap(err)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if p == skip {
			return nil
		}
		fi, err := f.root.Lstat(p)
		if err != nil {
			return wrap(err)
		}
		name := p
		if base != "." {
			name = strings.TrimPrefix(p, base+"/")
		}
		if p == "." {
			return nil // the root itself is not an entry
		}
		return fn(p, name, fi)
	})
}

func (f *rootFS) writeTarGz(ctx context.Context, w io.Writer, rels []string, skip string) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	for _, rel := range rels {
		err := f.walk(ctx, rel, skip, func(p, name string, fi iofs.FileInfo) error {
			var link string
			if fi.Mode()&iofs.ModeSymlink != 0 {
				link, _ = f.root.Readlink(p)
			} else if !fi.Mode().IsRegular() && !fi.IsDir() {
				return nil // sockets, devices, FIFOs
			}
			hdr, err := tar.FileInfoHeader(fi, link)
			if err != nil {
				return err
			}
			hdr.Name = name
			if fi.IsDir() {
				hdr.Name += "/"
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if fi.Mode().IsRegular() {
				return f.copyFile(ctx, tw, p)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

func (f *rootFS) writeZip(ctx context.Context, w io.Writer, rels []string, skip string) error {
	zw := zip.NewWriter(w)
	for _, rel := range rels {
		err := f.walk(ctx, rel, skip, func(p, name string, fi iofs.FileInfo) error {
			isLink := fi.Mode()&iofs.ModeSymlink != 0
			if !isLink && !fi.Mode().IsRegular() && !fi.IsDir() {
				return nil
			}
			hdr, err := zip.FileInfoHeader(fi)
			if err != nil {
				return err
			}
			hdr.Name = name
			if fi.IsDir() {
				hdr.Name += "/"
			} else {
				hdr.Method = zip.Deflate
			}
			out, err := zw.CreateHeader(hdr)
			if err != nil {
				return err
			}
			switch {
			case isLink:
				link, _ := f.root.Readlink(p)
				_, err = io.WriteString(out, link)
				return err
			case fi.Mode().IsRegular():
				return f.copyFile(ctx, out, p)
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return zw.Close()
}

func (f *rootFS) copyFile(ctx context.Context, w io.Writer, rel string) error {
	file, err := f.root.Open(rel)
	if err != nil {
		return wrap(err)
	}
	defer file.Close()
	_, err = copyCtx(ctx, w, file)
	return err
}

// Extract unpacks a .tar.gz, .tgz, .tar or .zip (detected from its first
// bytes) into destination. Entries with absolute names or ".." fail the
// extraction (os.Root would stop them anyway; this makes the error clear).
// Symlinks whose target leaves the destination, absolute ones included,
// are skipped: they are common in images (/usr/share/...) and harmless to
// leave out, but recreating them would plant an escape. Files get their
// archive mode bits (no setuid) and the owner of the destination folder.
func (f *rootFS) Extract(ctx context.Context, archivePath, destination string) error {
	src, err := cleanNotRoot(archivePath)
	if err != nil {
		return err
	}
	dest, err := clean(destination)
	if err != nil {
		return err
	}
	file, err := f.root.Open(src)
	if err != nil {
		return wrap(err)
	}
	defer file.Close()
	st, err := file.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return ErrNotRegular
	}
	if err := f.mkdirAll(dest); err != nil {
		return err
	}
	x := &extractor{fs: f, ctx: ctx, dest: dest}
	if free, ok := freeBytes(f.dir); ok {
		x.budget = int64(float64(free) * (1 - diskReserve))
	} else {
		x.budget = 1 << 62
	}

	var magic [262]byte
	n, _ := io.ReadFull(file, magic[:])
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	switch {
	case n >= 2 && magic[0] == 0x1f && magic[1] == 0x8b:
		gz, err := gzip.NewReader(bufio.NewReaderSize(file, 256<<10))
		if err != nil {
			return fmt.Errorf("reading gzip: %w", err)
		}
		defer gz.Close()
		return x.tar(tar.NewReader(gz))
	case n >= 4 && bytes.Equal(magic[:4], []byte("PK\x03\x04")):
		zr, err := zip.NewReader(file, st.Size())
		if err != nil {
			return fmt.Errorf("reading zip: %w", err)
		}
		return x.zip(zr)
	case n >= 262 && bytes.Equal(magic[257:262], []byte("ustar")):
		return x.tar(tar.NewReader(bufio.NewReaderSize(file, 256<<10)))
	}
	return fmt.Errorf("%w: not a .tar.gz, .tar or .zip archive", ErrNotRegular)
}

type extractor struct {
	fs      *rootFS
	ctx     context.Context
	dest    string
	budget  int64
	entries int
}

// target checks an entry name and returns its root-relative path.
func (x *extractor) target(name string) (string, error) {
	name = strings.TrimPrefix(name, "./")
	if name == "" || name == "." || name == "/" {
		return "", nil
	}
	if strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("%w: %q", ErrUnsafeEntry, name)
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if part == ".." {
			return "", fmt.Errorf("%w: %q", ErrUnsafeEntry, name)
		}
	}
	return path.Join(x.dest, path.Clean(name)), nil
}

// linkInside reports whether a symlink at rel with target stays inside the
// destination when resolved lexically.
func (x *extractor) linkInside(rel, target string) bool {
	if path.IsAbs(target) {
		return false
	}
	resolved := path.Join(path.Dir(rel), target)
	if x.dest == "." {
		return resolved != ".." && !strings.HasPrefix(resolved, "../")
	}
	return resolved == x.dest || strings.HasPrefix(resolved, x.dest+"/")
}

func (x *extractor) next() error {
	if err := x.ctx.Err(); err != nil {
		return err
	}
	x.entries++
	if x.entries > maxArchiveEntries {
		return fmt.Errorf("%w: more than %d entries", ErrUnsafeEntry, maxArchiveEntries)
	}
	return nil
}

func (x *extractor) dir(rel string) error {
	if rel == "" {
		return nil
	}
	return x.fs.mkdirAll(rel)
}

func (x *extractor) file(rel string, mode iofs.FileMode, r io.Reader) error {
	if err := x.fs.mkdirAll(path.Dir(rel)); err != nil {
		return err
	}
	if fi, err := x.fs.root.Lstat(rel); err == nil && (fi.IsDir() || fi.Mode()&iofs.ModeSymlink != 0) {
		// Never write through a symlink or over a folder an earlier entry
		// (or the volume) put there.
		if err := x.fs.root.RemoveAll(rel); err != nil {
			return wrap(err)
		}
	}
	out, err := x.fs.root.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
	if err != nil {
		return wrap(err)
	}
	_, err = copyCtx(x.ctx, &budgetWriter{w: out, left: &x.budget}, r)
	cerr := out.Close()
	if err != nil {
		return err
	}
	if cerr != nil {
		return cerr
	}
	_ = x.fs.root.Chmod(rel, mode.Perm())
	x.fs.chownLikeParent(rel)
	return nil
}

func (x *extractor) symlink(rel, target string) error {
	if !x.linkInside(rel, target) {
		return nil // see Extract
	}
	if err := x.fs.mkdirAll(path.Dir(rel)); err != nil {
		return err
	}
	_ = x.fs.root.Remove(rel)
	if err := x.fs.root.Symlink(target, rel); err != nil {
		return wrap(err)
	}
	x.fs.chownLikeParent(rel)
	return nil
}

func (x *extractor) tar(tr *tar.Reader) error {
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading tar: %w", err)
		}
		if err := x.next(); err != nil {
			return err
		}
		rel, err := x.target(hdr.Name)
		if err != nil {
			return err
		}
		if rel == "" {
			continue
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			err = x.dir(rel)
		case tar.TypeReg:
			err = x.file(rel, iofs.FileMode(hdr.Mode).Perm(), tr)
		case tar.TypeSymlink:
			err = x.symlink(rel, hdr.Linkname)
		case tar.TypeLink:
			var from string
			if from, err = x.target(hdr.Linkname); err == nil && from != "" {
				_ = x.fs.root.Remove(rel)
				err = wrap(x.fs.root.Link(from, rel))
			}
		default:
			continue // devices, FIFOs: not something a volume upload needs
		}
		if err != nil {
			return err
		}
	}
}

func (x *extractor) zip(zr *zip.Reader) error {
	for _, zf := range zr.File {
		if err := x.next(); err != nil {
			return err
		}
		rel, err := x.target(zf.Name)
		if err != nil {
			return err
		}
		if rel == "" {
			continue
		}
		mode := zf.Mode()
		switch {
		case mode.IsDir():
			err = x.dir(rel)
		case mode&iofs.ModeSymlink != 0:
			var target []byte
			if target, err = readZipEntry(zf, 4096); err == nil {
				err = x.symlink(rel, string(target))
			}
		case mode.IsRegular():
			var rc io.ReadCloser
			if rc, err = zf.Open(); err == nil {
				perm := mode.Perm()
				if perm == 0 {
					perm = 0o644
				}
				err = x.file(rel, perm, rc)
				rc.Close()
			}
		default:
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func readZipEntry(zf *zip.File, limit int64) ([]byte, error) {
	rc, err := zf.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(io.LimitReader(rc, limit))
}

// budgetWriter fails with ErrNoSpace once an extraction wrote more than
// the free space it started with.
type budgetWriter struct {
	w    io.Writer
	left *int64
}

func (b *budgetWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > *b.left {
		return 0, ErrNoSpace
	}
	n, err := b.w.Write(p)
	*b.left -= int64(n)
	return n, err
}
