//go:build integration

package build

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// TestITGiteaPrivateClone clones a private repository from a real Gitea
// (started by scripts/dev/it-gitea.sh) the way the panel sends a Gitea
// source: the connection's token through the credential helper, with the
// token owner as the user name, over HTTPS with the test server's CA. A
// clone without the token is refused, and so is any clone of this private
// address without allow_internal_host.
func TestITGiteaPrivateClone(t *testing.T) {
	repo := os.Getenv("SEYLO_IT_GITEA_REPO")
	if os.Getenv("SEYLO_IT") != "1" || repo == "" {
		t.Skip("needs the Gitea from scripts/dev/it-gitea.sh (SEYLO_IT_GITEA_REPO)")
	}
	token, user, ca, head := os.Getenv("SEYLO_IT_GITEA_TOKEN"), os.Getenv("SEYLO_IT_GITEA_USER"), os.Getenv("SEYLO_IT_GITEA_CA"), os.Getenv("SEYLO_IT_GITEA_HEAD")
	run := caRunner{ca: ca}
	ctx := context.Background()

	work := t.TempDir()
	dir := filepath.Join(work, "src")
	var log bytes.Buffer
	// The VM's own address: a host an admin allowed for the project.
	src := &agentv1.GitSource{Url: repo, Ref: "main", Commit: head, Token: token, Username: user, AllowInternalHost: true}
	if err := validateGit(src); err != nil {
		t.Fatal(err)
	}
	info, err := fetchGit(ctx, run, &log, src, dir, work, false)
	if err != nil {
		t.Fatalf("%v\n%s", err, log.String())
	}
	if head != "" && info.GetCommit() != head {
		t.Fatalf("cloned %s, want %s", info.GetCommit(), head)
	}
	if _, err := os.Stat(filepath.Join(dir, "app", "index.js")); err != nil {
		t.Fatalf("the pushed file is missing: %v", err)
	}
	if strings.Contains(log.String(), token) {
		t.Fatal("the token is in the log")
	}

	anon := t.TempDir()
	_, err = fetchGit(ctx, run, &log, &agentv1.GitSource{Url: repo, Ref: "main", AllowInternalHost: true}, filepath.Join(anon, "src"), anon, false)
	if !errors.Is(err, ErrFetch) || errors.Is(err, ErrBlockedHost) {
		t.Fatalf("a clone without the token: got %v, want ErrFetch", err)
	}

	// Without the panel's allow_internal_host the node does not connect to
	// the VM's private address at all, token or not.
	refused := t.TempDir()
	blocked := &agentv1.GitSource{Url: repo, Ref: "main", Commit: head, Token: token, Username: user}
	_, err = fetchGit(ctx, run, &log, blocked, filepath.Join(refused, "src"), refused, false)
	if !errors.Is(err, ErrBlockedHost) || !strings.Contains(err.Error(), "private address") {
		t.Fatalf("an internal Gitea without allow_internal_host: got %v", err)
	}
}
