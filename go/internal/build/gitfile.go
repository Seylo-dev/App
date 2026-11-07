package build

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// FetchGitFile limits.
const (
	DefaultGitFileMax = 1 << 20
	MaxGitFileMax     = 8 << 20
	gitFileTimeout    = 2 * time.Minute
)

// Errors of FetchFile callers map to statuses.
var (
	// ErrGitFileNotFound: the path is not a file at that ref.
	ErrGitFileNotFound = errors.New("the file is not in the repository at that ref")
	// ErrGitFileTooLarge: the file is larger than the request allows.
	ErrGitFileTooLarge = errors.New("the file is too large")
	// ErrNoGit: git is not installed on this node.
	ErrNoGit = errors.New("git is not installed on this node")
)

// FetchFile reads one file from a git repository with the build's clone
// code and credentials: a shallow fetch without file contents (where the
// server allows it), then only that file's blob. Nothing stays on the node.
func (s *Service) FetchFile(ctx context.Context, req *agentv1.FetchGitFileRequest) (*agentv1.FetchGitFileResponse, error) {
	src := req.GetSource()
	if src.GetUrl() == "" {
		return nil, &InvalidError{Msg: "the repository address is required"}
	}
	if err := validateGit(src); err != nil {
		return nil, err
	}
	if _, real := s.opts.Runner.(ExecRunner); real {
		if _, err := exec.LookPath("git"); err != nil {
			return nil, ErrNoGit
		}
	}
	p, err := cleanRepoPath(req.GetPath())
	if err != nil {
		return nil, err
	}
	limit := req.GetMaxBytes()
	if limit == 0 {
		limit = DefaultGitFileMax
	}
	limit = min(limit, MaxGitFileMax)

	ctx, cancel := context.WithTimeout(ctx, gitFileTimeout)
	defer cancel()
	work, err := s.tempDir("gitfile")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	var log bytes.Buffer
	g, err := newGit(s.opts.Runner, &log, src, work)
	if err != nil {
		return nil, fmt.Errorf("preparing git credentials: %w", err)
	}
	defer g.close()
	dir := filepath.Join(work, "repo")
	if err := g.do(ctx, "", "init", "-q", "--bare", dir); err != nil {
		return nil, fmt.Errorf("git init: %w", err)
	}
	if err := g.do(ctx, dir, "remote", "add", "origin", src.GetUrl()); err != nil {
		return nil, fmt.Errorf("git remote add: %w", err)
	}
	// A partial clone: blobs come on demand (with the same credentials,
	// which git passes to its own lazy fetch).
	for _, kv := range [][2]string{{"core.repositoryFormatVersion", "1"}, {"extensions.partialClone", "origin"},
		{"remote.origin.promisor", "true"}, {"remote.origin.partialCloneFilter", "blob:none"}} {
		if err := g.do(ctx, dir, "config", kv[0], kv[1]); err != nil {
			return nil, fmt.Errorf("git config: %w", err)
		}
	}
	ref := src.GetRef()
	if ref == "" {
		ref = "HEAD"
	}
	want := ref
	if src.GetCommit() != "" {
		want = src.GetCommit()
	}
	// A blobless fetch downloads the tree only; servers without partial
	// clone ignore the filter and send everything (still depth 1).
	fetch := func(what string, depth bool) error {
		args := []string{"fetch", "-q", "--no-tags", "--filter=blob:none"}
		if depth {
			args = append(args, "--depth", "1")
		}
		return g.do(ctx, dir, append(args, "origin", what)...)
	}
	target := "FETCH_HEAD"
	if err := fetch(want, true); err != nil {
		if src.GetCommit() == "" || ctx.Err() != nil {
			return nil, g.fetchErr(ctx, err, "could not fetch %s - check the address, the branch and the credentials", ref)
		}
		// The server does not serve commits by id: fetch the branch.
		if err := fetch(ref, false); err != nil {
			return nil, g.fetchErr(ctx, err, "could not fetch %s - check the address, the branch and the credentials", ref)
		}
		target = src.GetCommit()
	}
	commit, err := output(ctx, s.opts.Runner, g.cmd(dir, "rev-parse", "--verify", target+"^{commit}"))
	if err != nil {
		return nil, g.fetchErr(ctx, err, "commit %s is not on %s", short(src.GetCommit()), ref)
	}
	object := commit + ":" + p
	kind, err := output(ctx, s.opts.Runner, g.cmd(dir, "cat-file", "-t", object))
	if err != nil || kind != "blob" {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if refused := g.proxy.Refused(); refused != nil {
			return nil, refused
		}
		return nil, fmt.Errorf("%w: %s at %s", ErrGitFileNotFound, p, short(commit))
	}
	sizeText, err := output(ctx, s.opts.Runner, g.cmd(dir, "cat-file", "-s", object))
	if err != nil {
		return nil, g.fetchErr(ctx, err, "could not read %s", p)
	}
	size, err := strconv.ParseUint(sizeText, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("reading the size of %s: %w", p, err)
	}
	if size > limit {
		return nil, fmt.Errorf("%w: %s is %d bytes, the limit is %d", ErrGitFileTooLarge, p, size, limit)
	}
	var content bytes.Buffer
	cmd := g.cmd(dir, "cat-file", "blob", object)
	cmd.Stdout = &limitedBuffer{buf: &content, max: int(limit)}
	cmd.Stderr = io.Discard
	if err := s.opts.Runner.Run(ctx, cmd); err != nil {
		return nil, g.fetchErr(ctx, err, "could not read %s", p)
	}
	return &agentv1.FetchGitFileResponse{Content: content.Bytes(), Commit: commit, SizeBytes: uint64(content.Len())}, nil
}

// cleanRepoPath checks a path inside a repository: relative, no "..".
func cleanRepoPath(p string) (string, error) {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) || strings.ContainsRune(p, '\\') {
		return "", &InvalidError{Msg: fmt.Sprintf("path %q must be relative to the repository root", p)}
	}
	clean := path.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "-") {
		return "", &InvalidError{Msg: fmt.Sprintf("path %q leaves the repository", p)}
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", &InvalidError{Msg: fmt.Sprintf("path %q leaves the repository", p)}
		}
	}
	return clean, nil
}

// tempDir makes a private folder under the builds dir.
func (s *Service) tempDir(kind string) (string, error) {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	dir := filepath.Join(s.opts.Dir, "tmp", kind+"-"+hex.EncodeToString(b))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating a work folder: %w", err)
	}
	return dir, nil
}

// limitedBuffer refuses to grow past max (a file that grew between the
// size check and the read).
type limitedBuffer struct {
	buf *bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if l.buf.Len()+len(p) > l.max {
		return 0, ErrGitFileTooLarge
	}
	return l.buf.Write(p)
}
