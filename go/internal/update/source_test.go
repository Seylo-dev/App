package update

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
)

func TestReleaseOverrides(t *testing.T) {
	if ReleaseBase() != "https://github.com/"+brand.GitHubOrg+"/"+brand.GitHubRepo+"/releases" || ReleasePublicKey() != brand.MinisignPublicKey || IsTestBuild() {
		t.Fatal("a release build must use brand.json's values")
	}
	TestReleaseBaseURL, TestReleasePublicKey = "http://mirror.test/o/r/releases/", "RWtest"
	t.Cleanup(func() { TestReleaseBaseURL, TestReleasePublicKey = "", "" })
	if got := ReleaseURL("", ManifestFile); got != "http://mirror.test/o/r/releases/latest/download/manifest.json" {
		t.Fatalf("ReleaseURL = %s", got)
	}
	if ReleasePublicKey() != "RWtest" || !IsTestBuild() {
		t.Fatal("overrides ignored")
	}
}

// TestUpdateToLatest: an agent the panel refused as too old fetches the
// latest signed manifest from the release base and installs it.
func TestUpdateToLatest(t *testing.T) {
	f := newAgentFixture(t, "1.2.0")
	m := testManifest("1.2.0", f.binary, f.server.URL+"/seylo_linux_amd64")
	req := f.request(m)
	mirror := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/o/r/releases/latest/download/" + ManifestFile:
			_, _ = w.Write(req.GetManifest())
		case "/o/r/releases/latest/download/" + SignatureFile:
			_, _ = w.Write(req.GetManifestSignature())
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(mirror.Close)
	TestReleaseBaseURL = mirror.URL + "/o/r/releases"
	t.Cleanup(func() { TestReleaseBaseURL = "" })

	u := f.updater("1.1.0")
	if err := u.UpdateToLatest(context.Background(), "1.3.0"); !errors.Is(err, ErrRejected) || !strings.Contains(err.Error(), "older than the panel's minimum 1.3.0") {
		t.Fatalf("too-old latest: %v", err)
	}
	if err := u.UpdateToLatest(context.Background(), "1.2.0"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-f.system.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("no restart into the new agent")
	}
	if got := readString(t, f.exe); got != string(f.binary) {
		t.Fatalf("binary = %q", got)
	}

	// Without a signing key nothing is fetched.
	u2, _ := NewAgentUpdater(AgentOptions{DataDir: t.TempDir(), Executable: f.exe, CurrentVersion: "1.1.0", PublicKey: brand.PlaceholderPrefix + "KEY"}, nil)
	if err := u2.UpdateToLatest(context.Background(), ""); !errors.Is(err, ErrNoSigningKey) {
		t.Fatalf("placeholder key: %v", err)
	}
}
