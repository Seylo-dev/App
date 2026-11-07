package build

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// agentio-2 on the node. The panel vets a git host when a source is saved
// and again before a build or FetchGitFile goes out, but the node resolved
// the name again when it cloned: a name that answers the panel with a
// public address and the node with an internal one (DNS rebinding,
// split-horizon DNS) made the node clone from loopback or a private
// network, and FetchGitFile handed the file back. The node now checks the
// address each connection goes to; internal ones only when the panel says
// an admin allowed the host for the project (allow_internal_host).
func TestNodeRefusesInternalGitAddresses(t *testing.T) {
	url, _, run, hits := gitServerHits(t, defaultGitUser, "", nil)
	// "localhost" stands for a name that resolves to an internal address on the node only.
	byName := strings.Replace(url, "127.0.0.1", "localhost", 1)
	s := New(Options{Dir: t.TempDir(), Runner: run})
	defer s.Close()
	ctx := context.Background()

	for _, u := range []string{byName, url} {
		res, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: &agentv1.GitSource{Url: u, Ref: "main"}, Path: "a.txt"})
		// Before: the file came back.
		if !errors.Is(err, ErrFetch) || !strings.Contains(err.Error(), "loopback") {
			t.Fatalf("FetchGitFile %s: %v %q", u, err, res.GetContent())
		}
		work := t.TempDir()
		var log bytes.Buffer
		_, err = fetchGit(ctx, run, &log, &agentv1.GitSource{Url: u, Ref: "main"}, filepath.Join(work, "src"), work, false)
		if !errors.Is(err, ErrFetch) || !strings.Contains(err.Error(), "loopback") || !strings.Contains(log.String(), "Refused a git connection") {
			t.Fatalf("build fetch %s: %v\n%s", u, err, log.String())
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the internal git server got %d requests", n)
	}

	// The panel allowed the host for the project: the same fetches work.
	res, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: &agentv1.GitSource{Url: byName, Ref: "main", AllowInternalHost: true}, Path: "a.txt"})
	if err != nil || string(res.GetContent()) != "two\n" {
		t.Fatalf("allowed host: %v %v", res, err)
	}
	work := t.TempDir()
	var log bytes.Buffer
	if _, err := fetchGit(ctx, run, &log, &agentv1.GitSource{Url: url, Ref: "main", AllowInternalHost: true}, filepath.Join(work, "src"), work, false); err != nil {
		t.Fatalf("allowed host, build fetch: %v\n%s", err, log.String())
	}
}

// The allowance is for the source's own host and port: a redirect or a
// submodule to another internal address is refused like any other.
func TestAllowedGitHostDoesNotExtendToRedirectsOrSubmodules(t *testing.T) {
	other, otherWork, _, otherHits := gitServerHits(t, defaultGitUser, "", nil)
	otherBase := strings.TrimSuffix(other, "/repo.git")
	ctx := context.Background()

	// A redirect from the allowed host to another internal one.
	redirect, _, run, _ := gitServerHits(t, defaultGitUser, "", func(w http.ResponseWriter, r *http.Request) bool {
		http.Redirect(w, r, otherBase+r.URL.RequestURI(), http.StatusFound)
		return true
	})
	s := New(Options{Dir: t.TempDir(), Runner: run})
	defer s.Close()
	res, err := s.FetchFile(ctx, &agentv1.FetchGitFileRequest{Source: &agentv1.GitSource{Url: redirect, Ref: "main", AllowInternalHost: true}, Path: "a.txt"})
	// Before: git followed the redirect and the other server's file came back.
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("redirect to another internal host: %v %q", err, res.GetContent())
	}

	// A submodule on another internal host.
	allowed, work, run2, _ := gitServerHits(t, defaultGitUser, "", nil)
	sub := headOf(t, otherWork, "main")
	gitIn := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(work, ".gitmodules"), []byte("[submodule \"sub\"]\n\tpath = sub\n\turl = "+other+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(work, "update-index", "--add", "--cacheinfo", "160000,"+sub+",sub")
	gitIn(work, "add", ".gitmodules")
	gitIn(work, "commit", "-q", "-m", "with a submodule")
	gitIn(work, "push", "-q", filepath.Join(filepath.Dir(work), "repo.git"), "main")

	dir := t.TempDir()
	var log bytes.Buffer
	_, err = fetchGit(ctx, run2, &log, &agentv1.GitSource{Url: allowed, Ref: "main", AllowInternalHost: true}, filepath.Join(dir, "src"), dir, true)
	// Before: the submodule was cloned from the other server.
	if !errors.Is(err, ErrFetch) || !strings.Contains(log.String(), "Refused a git connection to "+strings.TrimPrefix(otherBase, "https://")) {
		t.Fatalf("submodule on another internal host: %v\n%s", err, log.String())
	}
	if n := otherHits.Load(); n != 0 {
		t.Fatalf("the other internal server got %d requests", n)
	}
}
