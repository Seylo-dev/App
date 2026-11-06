package build

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Limits for uploaded build contexts.
const (
	// MaxUploadBytes is the largest .tar.gz the agent accepts.
	MaxUploadBytes = 2 << 30
	// maxExtractedBytes and maxExtractedFiles stop archive bombs.
	maxExtractedBytes = 10 << 30
	maxExtractedFiles = 200_000
	// uploadTTL is how long an unused upload is kept.
	uploadTTL = 24 * time.Hour
)

// ErrUploadNotFound means a build named an upload id the node does not
// have (never sent, already expired, or sent to another node).
var ErrUploadNotFound = errors.New("uploaded build context not found")

// uploads stores .tar.gz build contexts until a build uses them.
type uploads struct {
	dir string
}

func (u uploads) path(id string) string { return filepath.Join(u.dir, id+".tar.gz") }

// store writes archive to disk, checking its size and SHA-256 before it
// becomes visible under its id.
func (u uploads) store(ctx context.Context, req *agentv1.UploadBuildContextRequest, archive io.Reader) error {
	if !idRe.MatchString(req.GetUploadId()) {
		return invalid("upload id %q is not valid", req.GetUploadId())
	}
	want := strings.ToLower(req.GetSha256())
	if !sha256Re.MatchString(want) {
		return invalid("the upload needs the archive's SHA-256 in hex")
	}
	if req.GetSizeBytes() == 0 || req.GetSizeBytes() > MaxUploadBytes {
		return invalid("build contexts must be between 1 byte and %d MiB", MaxUploadBytes>>20)
	}
	if err := os.MkdirAll(u.dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(u.dir, ".upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	h := sha256.New()
	// One byte more than announced shows an oversized stream.
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(ctxReader{ctx, archive}, int64(req.GetSizeBytes())+1))
	if err != nil {
		return fmt.Errorf("receiving the build context: %w", err)
	}
	if uint64(n) != req.GetSizeBytes() {
		return invalid("received %d bytes, expected %d", n, req.GetSizeBytes())
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return invalid("the archive's SHA-256 is %s, expected %s", got, want)
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), u.path(req.GetUploadId()))
}

// expire removes uploads older than uploadTTL and abandoned temp files.
func (u uploads) expire(now time.Time) {
	entries, err := os.ReadDir(u.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		info, err := e.Info()
		if err == nil && now.Sub(info.ModTime()) > uploadTTL {
			_ = os.Remove(filepath.Join(u.dir, e.Name()))
		}
	}
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(b []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(b)
}

// extractArchive unpacks a .tar.gz into dir (which must exist). Entries
// that would land outside dir, devices and archives over the limits are
// refused. Symlinks are created last, and never inside a symlinked folder,
// so no entry is ever written through a link; checkTree then refuses links
// that resolve outside the source.
func extractArchive(ctx context.Context, archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return invalid("the build context is not a .tar.gz archive")
	}
	defer zr.Close()
	tr := tar.NewReader(zr)

	type link struct{ name, target string }
	var links []link
	var total int64
	files := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return invalid("the build context archive is damaged: %v", err)
		}
		files++
		if files > maxExtractedFiles {
			return invalid("the build context has more than %d files", maxExtractedFiles)
		}
		name, ok := archivePath(hdr.Name)
		if !ok {
			return invalid("the archive entry %q points outside the build context", hdr.Name)
		}
		if name == "" {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		mode := os.FileMode(hdr.Mode).Perm() &^ 0o022
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			total += hdr.Size
			if total > maxExtractedBytes {
				return invalid("the build context is larger than %d GiB unpacked", maxExtractedBytes>>30)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := writeFile(target, tr, mode|0o600); err != nil {
				return err
			}
		case tar.TypeSymlink:
			links = append(links, link{name, hdr.Linkname})
		case tar.TypeLink:
			src, ok := archivePath(hdr.Linkname)
			if !ok || src == "" {
				return invalid("the hard link %q points outside the build context", hdr.Name)
			}
			srcPath := filepath.Join(dir, filepath.FromSlash(src))
			if fi, err := os.Lstat(srcPath); err != nil || !fi.Mode().IsRegular() {
				return invalid("the hard link %q has no file to point at", hdr.Name)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Link(srcPath, target); err != nil {
				return err
			}
		default:
			// Devices, fifos and the like have no place in a build context.
		}
	}
	for _, l := range links {
		if l.target == "" || strings.Contains(l.target, "\x00") {
			return invalid("the symlink %q has no target", l.name)
		}
		target := filepath.Join(dir, filepath.FromSlash(l.name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := noLinkedParents(dir, l.name); err != nil {
			return err
		}
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return invalid("the symlink %q replaces a folder", l.name)
		}
		if err := os.Symlink(l.target, target); err != nil {
			return err
		}
	}
	return nil
}

// noLinkedParents fails when a folder on the way to name is a symlink.
func noLinkedParents(root, name string) error {
	p := root
	parts := strings.Split(path.Dir(name), "/")
	for _, part := range parts {
		if part == "." || part == "" {
			continue
		}
		p = filepath.Join(p, part)
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return invalid("the archive entry %q is inside a symlinked folder", name)
		}
	}
	return nil
}

// checkTree refuses sources with symlinks that resolve outside root, so
// builders that read files (Railpack, Nixpacks) never read the node's.
func checkTree(ctx context.Context, root string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.Type()&os.ModeSymlink == 0 {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			// Dangling: judge the target as written, from the link's folder.
			target, rerr := os.Readlink(p)
			dir, derr := filepath.EvalSymlinks(filepath.Dir(p))
			if rerr != nil || derr != nil || filepath.IsAbs(target) {
				return invalid("the symlink %s points outside the source", filepath.ToSlash(rel))
			}
			real = filepath.Join(dir, target)
		}
		if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
			return invalid("the symlink %s points outside the source", filepath.ToSlash(rel))
		}
		return nil
	})
}

// archivePath cleans an entry name; ok is false when it escapes the root.
func archivePath(name string) (string, bool) {
	name = strings.TrimPrefix(name, "./")
	if path.IsAbs(name) || strings.Contains(name, "\x00") {
		return "", false
	}
	c := path.Clean(name)
	if c == "." {
		return "", true
	}
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", false
	}
	return c, true
}

// noFollow makes opening a planted symlink fail instead of writing
// through it.
const noFollow = syscall.O_NOFOLLOW

// writeFile writes r to target without following a symlink planted there
// by an earlier entry.
func writeFile(target string, r io.Reader, mode os.FileMode) error {
	if fi, err := os.Lstat(target); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(target); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY|noFollow, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// insideRoot resolves rel under root (following symlinks) and fails when
// the result leaves root. what names the path in the error.
func insideRoot(root, rel, what string) (string, error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	p := filepath.Join(root, filepath.FromSlash(rel))
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", invalid("%s %s does not exist in the source", what, displayPath(rel))
		}
		return "", err
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
		return "", invalid("%s %s points outside the source", what, displayPath(rel))
	}
	return real, nil
}

func displayPath(rel string) string {
	if rel == "" || rel == "." {
		return "/"
	}
	return rel
}
