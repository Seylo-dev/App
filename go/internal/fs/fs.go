package fs

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// FS operates on files under one root. Paths are slash separated and
// relative to the root (a leading "/" is accepted and means the root);
// ".." components and symlinks that lead outside are errors.
type FS interface {
	List(ctx context.Context, path string) ([]*agentv1.FileInfo, error)
	Stat(ctx context.Context, path string) (*agentv1.FileInfo, error)
	// Open returns a reader over [offset, offset+length) of a regular file;
	// length 0 reads to the end.
	Open(ctx context.Context, path string, offset, length uint64) (io.ReadCloser, *agentv1.FileInfo, error)
	// Create starts an upload. Without append it writes a temporary file
	// and swaps it in on Commit, so a failed upload never leaves half a
	// file behind.
	Create(ctx context.Context, req *agentv1.FsWriteRequest) (Upload, error)
	Mkdir(ctx context.Context, path string, parents bool) error
	// Rename fails when the target exists.
	Rename(ctx context.Context, from, to string) error
	// Remove deletes files and directories (recursively). The root itself
	// cannot be removed.
	Remove(ctx context.Context, paths []string) error
	Chmod(ctx context.Context, path string, mode uint32) error
	Archive(ctx context.Context, paths []string, destination string, format agentv1.ArchiveFormat) (*agentv1.FileInfo, error)
	Extract(ctx context.Context, archivePath, destination string) error
	// Close releases the root.
	Close() error
}

// Upload is a file being written.
type Upload interface {
	io.Writer
	// Commit finishes the file and returns its info.
	Commit() (*agentv1.FileInfo, error)
	// Abort drops a replacement upload (an append keeps what was written).
	Abort() error
}

// Roots opens the FS of a service volume.
type Roots interface {
	Open(root *agentv1.FsRoot) (FS, error)
}
