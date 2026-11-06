package fs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path"
	"slices"
	"strings"
	"syscall"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Errors callers map to statuses. Missing and existing files come back as
// io/fs.ErrNotExist and io/fs.ErrExist.
var (
	// ErrInvalidPath: "..", NUL bytes, or an operation on the root itself.
	ErrInvalidPath = errors.New("fs: invalid path")
	// ErrEscape: a symlink points outside the root.
	ErrEscape = errors.New("fs: path leads outside the volume")
	// ErrNotRegular: reading or chmod of something that is not a regular
	// file or directory (devices, sockets, FIFOs).
	ErrNotRegular = errors.New("fs: not a regular file")
	// ErrIsDir: writing to a directory.
	ErrIsDir = errors.New("fs: is a directory")
	// ErrNotDir: listing a file.
	ErrNotDir = errors.New("fs: not a directory")
	// ErrNoSpace: the upload or extraction does not fit on the disk.
	ErrNoSpace = errors.New("fs: not enough disk space")
	// ErrUnsafeEntry: an archive entry would land outside the destination.
	ErrUnsafeEntry = errors.New("fs: unsafe archive entry")
)

// MaxListEntries bounds one directory listing.
const MaxListEntries = 50000

// rootFS is an FS over one os.Root. os.Root resolves every path one
// component at a time with openat and O_NOFOLLOW and rejects symlinks
// that leave the root, the same guarantee as Wings' ufs (openat2 with
// RESOLVE_IN_ROOT) without the hand-written syscalls.
type rootFS struct {
	root *os.Root
	dir  string
	// chown makes new files belong to the owner of their parent folder,
	// so uploads into a volume used by a non-root container stay writable
	// for it. Only possible when the agent runs as root.
	chown bool
}

// OpenDir returns an FS rooted at dir (which must exist).
func OpenDir(dir string) (FS, error) {
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &rootFS{root: r, dir: dir, chown: os.Geteuid() == 0}, nil
}

func (f *rootFS) Close() error { return f.root.Close() }

// clean turns a request path into a root-relative one ("." for the root).
func clean(p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("%w: NUL byte", ErrInvalidPath)
	}
	p = strings.Trim(p, "/")
	if p == "" {
		return ".", nil
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", fmt.Errorf("%w: %q", ErrInvalidPath, p)
		}
	}
	return path.Clean(p), nil
}

// cleanNotRoot is clean for operations that must not target the root.
func cleanNotRoot(p string) (string, error) {
	c, err := clean(p)
	if err == nil && c == "." {
		return "", fmt.Errorf("%w: the volume root itself", ErrInvalidPath)
	}
	return c, err
}

// wrap turns os.Root's escape error into ErrEscape.
func wrap(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(err.Error(), "path escapes from parent") {
		return fmt.Errorf("%w: %v", ErrEscape, err)
	}
	return err
}

func info(rel string, fi iofs.FileInfo, link string) *agentv1.FileInfo {
	name := path.Base(rel)
	if rel == "." {
		name, rel = "", ""
	}
	out := &agentv1.FileInfo{
		Name:          name,
		Path:          rel,
		IsDir:         fi.IsDir(),
		Mode:          unixMode(fi.Mode()),
		ModifiedAt:    timestamppb.New(fi.ModTime()),
		SymlinkTarget: link,
	}
	if fi.Mode().IsRegular() {
		out.Size = uint64(fi.Size())
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		out.Uid, out.Gid = st.Uid, st.Gid
	}
	return out
}

// unixMode is the permission bits plus setuid, setgid and sticky.
func unixMode(m iofs.FileMode) uint32 {
	u := uint32(m.Perm())
	if m&iofs.ModeSetuid != 0 {
		u |= 0o4000
	}
	if m&iofs.ModeSetgid != 0 {
		u |= 0o2000
	}
	if m&iofs.ModeSticky != 0 {
		u |= 0o1000
	}
	return u
}

// goMode is the reverse of unixMode.
func goMode(u uint32) iofs.FileMode {
	m := iofs.FileMode(u & 0o777)
	if u&0o4000 != 0 {
		m |= iofs.ModeSetuid
	}
	if u&0o2000 != 0 {
		m |= iofs.ModeSetgid
	}
	if u&0o1000 != 0 {
		m |= iofs.ModeSticky
	}
	return m
}

// lstat returns the FileInfo of rel without following a final symlink.
func (f *rootFS) lstat(rel string) (*agentv1.FileInfo, error) {
	fi, err := f.root.Lstat(rel)
	if err != nil {
		return nil, wrap(err)
	}
	var link string
	if fi.Mode()&iofs.ModeSymlink != 0 {
		link, _ = f.root.Readlink(rel)
	}
	return info(rel, fi, link), nil
}

func (f *rootFS) Stat(_ context.Context, p string) (*agentv1.FileInfo, error) {
	rel, err := clean(p)
	if err != nil {
		return nil, err
	}
	return f.lstat(rel)
}

func (f *rootFS) List(_ context.Context, p string) ([]*agentv1.FileInfo, error) {
	rel, err := clean(p)
	if err != nil {
		return nil, err
	}
	d, err := f.root.Open(rel)
	if err != nil {
		return nil, wrap(err)
	}
	defer d.Close()
	st, err := d.Stat()
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, ErrNotDir
	}
	entries, err := d.ReadDir(MaxListEntries)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	out := make([]*agentv1.FileInfo, 0, len(entries))
	for _, e := range entries {
		child := path.Join(rel, e.Name())
		fi, err := e.Info() // lstat
		if err != nil {
			continue // removed meanwhile
		}
		var link string
		if fi.Mode()&iofs.ModeSymlink != 0 {
			link, _ = f.root.Readlink(child)
		}
		out = append(out, info(child, fi, link))
	}
	slices.SortFunc(out, func(a, b *agentv1.FileInfo) int {
		if a.GetIsDir() != b.GetIsDir() {
			if a.GetIsDir() {
				return -1
			}
			return 1
		}
		return strings.Compare(a.GetName(), b.GetName())
	})
	return out, nil
}

func (f *rootFS) Open(_ context.Context, p string, offset, length uint64) (io.ReadCloser, *agentv1.FileInfo, error) {
	rel, err := cleanNotRoot(p)
	if err != nil {
		return nil, nil, err
	}
	file, err := f.root.Open(rel)
	if err != nil {
		return nil, nil, wrap(err)
	}
	st, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !st.Mode().IsRegular() {
		file.Close()
		if st.IsDir() {
			return nil, nil, ErrIsDir
		}
		return nil, nil, ErrNotRegular
	}
	if offset > 0 {
		if _, err := file.Seek(int64(offset), io.SeekStart); err != nil {
			file.Close()
			return nil, nil, err
		}
	}
	var r io.Reader = file
	if length > 0 {
		r = io.LimitReader(file, int64(length))
	}
	return readCloser{r, file}, info(rel, st, ""), nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// owner returns the uid and gid of rel, or false.
func (f *rootFS) owner(rel string) (int, int, bool) {
	fi, err := f.root.Lstat(rel)
	if err != nil {
		return 0, 0, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	return int(st.Uid), int(st.Gid), true
}

// chownLikeParent gives rel the owner of its folder.
func (f *rootFS) chownLikeParent(rel string) {
	if !f.chown {
		return
	}
	if uid, gid, ok := f.owner(path.Dir(rel)); ok {
		_ = f.root.Lchown(rel, uid, gid)
	}
}

// mkdirAll creates rel and missing parents, each owned like its parent.
func (f *rootFS) mkdirAll(rel string) error {
	if rel == "." {
		return nil
	}
	cur := "."
	for _, part := range strings.Split(rel, "/") {
		cur = path.Join(cur, part)
		err := f.root.Mkdir(cur, 0o755)
		if err == nil {
			f.chownLikeParent(cur)
			continue
		}
		if !errors.Is(err, iofs.ErrExist) {
			return wrap(err)
		}
		st, err := f.root.Stat(cur)
		if err != nil {
			return wrap(err)
		}
		if !st.IsDir() {
			return fmt.Errorf("%w: %s", ErrNotDir, cur)
		}
	}
	return nil
}

func (f *rootFS) Mkdir(_ context.Context, p string, parents bool) error {
	rel, err := cleanNotRoot(p)
	if err != nil {
		return err
	}
	if parents {
		return f.mkdirAll(rel)
	}
	if err := f.root.Mkdir(rel, 0o755); err != nil {
		return wrap(err)
	}
	f.chownLikeParent(rel)
	return nil
}

func (f *rootFS) Rename(_ context.Context, from, to string) error {
	a, err := cleanNotRoot(from)
	if err != nil {
		return err
	}
	b, err := cleanNotRoot(to)
	if err != nil {
		return err
	}
	if _, err := f.root.Lstat(b); err == nil {
		return fmt.Errorf("%w: %s", iofs.ErrExist, b)
	}
	if strings.HasPrefix(b+"/", a+"/") {
		return fmt.Errorf("%w: cannot move a folder into itself", ErrInvalidPath)
	}
	return wrap(f.root.Rename(a, b))
}

func (f *rootFS) Remove(_ context.Context, paths []string) error {
	var rels []string
	for _, p := range paths {
		rel, err := cleanNotRoot(p)
		if err != nil {
			return err
		}
		rels = append(rels, rel)
	}
	for _, rel := range rels {
		if _, err := f.root.Lstat(rel); err != nil {
			return wrap(err)
		}
		if err := f.root.RemoveAll(rel); err != nil {
			return wrap(err)
		}
	}
	return nil
}

func (f *rootFS) Chmod(_ context.Context, p string, mode uint32) error {
	rel, err := clean(p)
	if err != nil {
		return err
	}
	st, err := f.root.Stat(rel)
	if err != nil {
		return wrap(err)
	}
	if !st.Mode().IsRegular() && !st.IsDir() {
		return ErrNotRegular
	}
	// fchmod on an open descriptor: os.Root.Chmod can be raced into
	// changing a symlink swapped in meanwhile.
	file, err := f.root.Open(rel)
	if err != nil {
		return wrap(err)
	}
	defer file.Close()
	return file.Chmod(goMode(mode))
}

// freeBytes is the space available to unprivileged writers under dir.
func freeBytes(dir string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true
}

func randomSuffix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (f *rootFS) Create(_ context.Context, req *agentv1.FsWriteRequest) (Upload, error) {
	rel, err := cleanNotRoot(req.GetPath())
	if err != nil {
		return nil, err
	}
	if n := req.GetSizeBytes(); n > 0 {
		if free, ok := freeBytes(f.dir); ok && free < n {
			return nil, fmt.Errorf("%w: %d bytes needed, %d free", ErrNoSpace, n, free)
		}
	}
	dir := path.Dir(rel)
	if req.GetCreateParents() {
		if err := f.mkdirAll(dir); err != nil {
			return nil, err
		}
	}
	existing, err := f.root.Stat(rel)
	switch {
	case err == nil && existing.IsDir():
		return nil, ErrIsDir
	case err == nil && !existing.Mode().IsRegular():
		return nil, ErrNotRegular
	case err != nil && !errors.Is(err, iofs.ErrNotExist):
		return nil, wrap(err)
	}
	mode := goMode(req.GetMode())
	if req.GetMode() == 0 {
		mode = 0o644
	}
	if req.GetAppend() {
		file, err := f.root.OpenFile(rel, os.O_WRONLY|os.O_APPEND|os.O_CREATE, mode)
		if err != nil {
			return nil, wrap(err)
		}
		if existing == nil {
			f.chownLikeParent(rel)
		}
		return &upload{fs: f, file: file, rel: rel}, nil
	}
	tmp := path.Join(dir, ".~"+path.Base(rel)+".upload-"+randomSuffix())
	file, err := f.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, wrap(err)
	}
	u := &upload{fs: f, file: file, rel: rel, tmp: tmp, mode: mode}
	if existing != nil {
		// A replaced file keeps its mode and owner.
		u.mode = existing.Mode() & (iofs.ModePerm | iofs.ModeSetuid | iofs.ModeSetgid | iofs.ModeSticky)
		if st, ok := existing.Sys().(*syscall.Stat_t); ok {
			u.uid, u.gid, u.keepOwner = int(st.Uid), int(st.Gid), true
		}
	}
	return u, nil
}

type upload struct {
	fs   *rootFS
	file *os.File
	rel  string
	// Replacement uploads only.
	tmp       string
	mode      iofs.FileMode
	uid, gid  int
	keepOwner bool
	done      bool
}

func (u *upload) Write(p []byte) (int, error) {
	n, err := u.file.Write(p)
	if errors.Is(err, syscall.ENOSPC) {
		err = fmt.Errorf("%w: %v", ErrNoSpace, err)
	}
	return n, err
}

func (u *upload) Commit() (*agentv1.FileInfo, error) {
	if u.done {
		return nil, errors.New("fs: upload already finished")
	}
	u.done = true
	if u.tmp == "" {
		if err := u.file.Close(); err != nil {
			return nil, err
		}
		return u.fs.lstat(u.rel)
	}
	if err := u.file.Chmod(u.mode); err != nil {
		u.abort()
		return nil, err
	}
	if err := u.file.Close(); err != nil {
		_ = u.fs.root.Remove(u.tmp)
		return nil, err
	}
	if u.keepOwner && u.fs.chown {
		_ = u.fs.root.Lchown(u.tmp, u.uid, u.gid)
	} else if !u.keepOwner {
		u.fs.chownLikeParent(u.tmp)
	}
	if err := u.fs.root.Rename(u.tmp, u.rel); err != nil {
		_ = u.fs.root.Remove(u.tmp)
		return nil, wrap(err)
	}
	return u.fs.lstat(u.rel)
}

func (u *upload) Abort() error {
	if u.done {
		return nil
	}
	u.done = true
	u.abort()
	return nil
}

func (u *upload) abort() {
	_ = u.file.Close()
	if u.tmp != "" {
		_ = u.fs.root.Remove(u.tmp)
	}
}

// copyCtx copies until EOF or ctx ends.
func copyCtx(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buf := make([]byte, 64<<10)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			w, werr := dst.Write(buf[:n])
			total += int64(w)
			if werr != nil {
				return total, werr
			}
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			return total, rerr
		}
	}
}
