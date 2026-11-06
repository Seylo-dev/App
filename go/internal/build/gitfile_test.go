package build

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func TestFetchGitFile(t *testing.T) {
	url, repo, run := gitServer(t, "tok")
	// Partial clone on the server: only the asked blob travels.
	if out, err := exec.Command("git", "-C", strings.TrimSuffix(repo, "work")+"repo.git", "config", "uploadpack.allowFilter", "true").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	s := New(Options{Dir: t.TempDir(), Runner: run})
	ctx := context.Background()
	src := func(ref, commit string) *agentv1.GitSource {
		return &agentv1.GitSource{Url: url, Ref: ref, Commit: commit, Token: "tok"}
	}
	cases := []struct {
		name string
		src  *agentv1.GitSource
		want string
	}{
		{"default branch", src("", ""), "two\n"},
		{"branch", src("other", ""), "other\n"},
		{"commit", src("main", headOf(t, repo, "main~1")), "one\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: c.src, Path: "a.txt"})
			if err != nil {
				t.Fatal(err)
			}
			if string(res.GetContent()) != c.want || res.GetSizeBytes() != uint64(len(c.want)) || len(res.GetCommit()) != 40 {
				t.Fatalf("res = %v", res)
			}
		})
	}
	if _, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: src("", ""), Path: "missing.yml"}); !errors.Is(err, ErrGitFileNotFound) {
		t.Fatalf("missing file: %v", err)
	}
	if _, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: src("", ""), Path: "a.txt", MaxBytes: 2}); !errors.Is(err, ErrGitFileTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../x", "-c"} {
		var inv *InvalidError
		if _, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: src("", ""), Path: bad}); !errors.As(err, &inv) {
			t.Errorf("path %q: %v", bad, err)
		}
	}
	bad := src("", "")
	bad.Token = "wrong"
	if _, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: bad, Path: "a.txt"}); !errors.Is(err, ErrFetch) || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("wrong token: %v", err)
	}
}
