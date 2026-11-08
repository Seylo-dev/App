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
	"slices"
)

// ArchiveOptions shape what WriteArchive writes.
type ArchiveOptions struct {
	// Level is the gzip level; 0 means gzip.DefaultCompression.
	Level int
	// DotPrefix names entries "./<path>" and adds a "./" entry for the
	// folder itself (the backup format). Without it entries are "<path>"
	// and the folder itself has no entry (the move format).
	DotPrefix bool
	// HardLinks stores the later paths of an inode as hard links to the
	// first one. Without it every path is a full copy.
	HardLinks bool
}

// WriteArchive writes the folder dir as a gzipped tar to w and returns
// the uncompressed file bytes archived: regular files, folders and
// symlinks with modes, numeric owners and times. Symlinks are stored,
// never followed; sockets, devices and pipes are skipped.
//
// dir may be a live volume a container keeps writing to, as root. So
// nothing is opened by path: every folder is entered through an os.Root
// opened from its parent, one name at a time, and every file is opened
// before its header is written and must still be the regular file (same
// device and inode) the folder listed. A file or folder swapped for a
// symlink mid-walk is skipped, so host files can never end up in the
// archive. Entries that vanish while we walk are skipped too.
func WriteArchive(ctx context.Context, dir string, w io.Writer, opts ArchiveOptions) (uint64, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return 0, fmt.Errorf("opening %s: %w", dir, err)
	}
	defer root.Close()
	return writeArchive(ctx, root, w, opts)
}

func writeArchive(ctx context.Context, root *os.Root, w io.Writer, opts ArchiveOptions) (uint64, error) {
	level := opts.Level
	if level == 0 {
		level = gzip.DefaultCompression
	}
	gz, err := gzip.NewWriterLevel(w, level)
	if err != nil {
		return 0, err
	}
	a := &archiver{ctx: ctx, tw: tar.NewWriter(gz), opts: opts, seen: map[inodeKey]string{}}
	top, err := root.Stat(".")
	if err != nil {
		return 0, err
	}
	if opts.DotPrefix {
		if err := a.header(top, "", "."); err != nil {
			return 0, err
		}
	}
	if err := a.dir(root, ""); err != nil {
		return a.total, err
	}
	if err := a.tw.Close(); err != nil {
		return a.total, err
	}
	return a.total, gz.Close()
}

type archiver struct {
	ctx   context.Context
	tw    *tar.Writer
	opts  ArchiveOptions
	seen  map[inodeKey]string
	total uint64
	buf   []byte
}

// name is the archive name of rel ("" is the folder itself).
func (a *archiver) name(rel string, isDir bool) string {
	n := rel
	if a.opts.DotPrefix {
		n = "./" + rel
	}
	if isDir && rel != "" {
		n += "/"
	}
	return n
}

func (a *archiver) header(info fs.FileInfo, link, rel string) error {
	if rel == "." {
		rel = ""
	}
	hdr, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return err
	}
	hdr.Name = a.name(rel, info.IsDir())
	hdr.Uname, hdr.Gname = "", ""
	hdr.Format = tar.FormatPAX
	return a.tw.WriteHeader(hdr)
}

// dir archives the entries of the folder r, whose archive path is rel.
func (a *archiver) dir(r *os.Root, rel string) error {
	f, err := r.Open(".")
	if err != nil {
		return err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return err
	}
	slices.SortFunc(entries, func(x, y fs.DirEntry) int {
		switch {
		case x.Name() < y.Name():
			return -1
		case x.Name() > y.Name():
			return 1
		}
		return 0
	})
	for _, e := range entries {
		if err := a.ctx.Err(); err != nil {
			return err
		}
		child := e.Name()
		if rel != "" {
			child = rel + "/" + e.Name()
		}
		if err := a.entry(r, e.Name(), child); err != nil {
			return err
		}
	}
	return nil
}

// entry archives one name of the folder r. Lstat of a single name never
// follows a symlink, and what is opened afterwards is checked against it.
func (a *archiver) entry(r *os.Root, base, rel string) error {
	info, err := r.Lstat(base)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // deleted while we walked
	}
	if err != nil {
		return err
	}
	mode := info.Mode()
	switch {
	case mode&fs.ModeSymlink != 0:
		link, err := r.Readlink(base)
		if err != nil {
			return nil // gone or no longer a link since the Lstat
		}
		return a.header(info, link, rel)
	case mode.IsDir():
		sub, err := r.OpenRoot(base)
		if err != nil {
			return skipRace(err)
		}
		defer sub.Close()
		now, err := sub.Stat(".")
		if err != nil {
			return skipRace(err)
		}
		if !now.IsDir() || !os.SameFile(now, info) {
			return nil // swapped since the listing: not the folder we saw
		}
		if err := a.header(now, "", rel); err != nil {
			return err
		}
		return a.dir(sub, rel)
	case mode.IsRegular():
		return a.file(r, base, rel, info)
	default:
		return nil // sockets, devices, pipes
	}
}

// file archives a regular file. It is opened first (non-blocking, so a
// pipe swapped in cannot hang us) and must still be the file the folder
// listed; the header comes from the open descriptor.
func (a *archiver) file(r *os.Root, base, rel string, listed fs.FileInfo) error {
	f, err := r.OpenFile(base, os.O_RDONLY|openNonblock, 0)
	if err != nil {
		return skipRace(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !os.SameFile(info, listed) {
		return nil // swapped since the listing (a symlink, a pipe, another file)
	}
	if a.opts.HardLinks {
		if key, ok := inodeOf(info); ok {
			if first, dup := a.seen[key]; dup {
				hdr, err := tar.FileInfoHeader(info, "")
				if err != nil {
					return err
				}
				hdr.Name, hdr.Typeflag, hdr.Linkname, hdr.Size = a.name(rel, false), tar.TypeLink, a.name(first, false), 0
				hdr.Uname, hdr.Gname = "", ""
				hdr.Format = tar.FormatPAX
				return a.tw.WriteHeader(hdr)
			}
			a.seen[key] = rel
		}
	}
	if err := a.header(info, "", rel); err != nil {
		return err
	}
	// The size is fixed in the header: a file that grows while we copy is
	// cut there, one that shrinks is padded with zeros (like GNU tar), so
	// a live volume still gives a valid archive.
	if a.buf == nil {
		a.buf = make([]byte, 32<<10)
	}
	n, err := io.CopyBuffer(a.tw, io.LimitReader(f, info.Size()), a.buf)
	a.total += uint64(n)
	if err != nil {
		return fmt.Errorf("reading %s: %w", rel, err)
	}
	if short := info.Size() - n; short > 0 {
		if _, err := io.CopyN(a.tw, zeros{}, short); err != nil {
			return err
		}
	}
	return nil
}

// skipRace turns "the entry changed under us" into a skip: it vanished,
// became something else, or now points out of the folder.
func skipRace(err error) error {
	if errors.Is(err, fs.ErrNotExist) || isEscapeOrLoop(err) {
		return nil
	}
	return err
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// ArchiveMode is the mode an extracted entry gets from its header (a
// volume move or a backup restore). tar keeps the unix bits (0o4000
// setuid, 0o2000 setgid, 0o1000 sticky), which are not where fs.FileMode
// keeps them, so they are mapped one by one. Sticky stays (shared folders
// such as /tmp keep users from deleting each other's files), and so does
// setgid on folders (new files inherit the folder's group). setuid, and
// setgid on files, are dropped like uploads drop them (fs.userMode): the
// agent writes as root, so a kept bit would make a root-owned setuid
// program in a volume, and volumes are not mounted nosuid.
func ArchiveMode(hdr *tar.Header) fs.FileMode {
	m := fs.FileMode(hdr.Mode).Perm()
	if hdr.Mode&0o1000 != 0 {
		m |= fs.ModeSticky
	}
	if hdr.Mode&0o2000 != 0 && hdr.Typeflag == tar.TypeDir {
		m |= fs.ModeSetgid
	}
	return m
}
