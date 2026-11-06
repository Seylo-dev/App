package update

import (
	"strings"

	"github.com/seylo-dev/app/go/gen/brand"
)

// Test-build overrides, for the end-to-end tests only. Release builds leave
// them empty and use brand.json's GitHub releases and minisign key. Set them
// with the linker:
//
//	-X github.com/seylo-dev/app/go/internal/update.TestReleaseBaseURL=http://192.168.64.1:18555/Seylo-dev/App/releases
//	-X github.com/seylo-dev/app/go/internal/update.TestReleasePublicKey=RW...
//
// TestReleaseBaseURL replaces "https://github.com/<org>/<repo>/releases"
// (same layout: /latest/download/<file> and /download/v<ver>/<file>).
var (
	TestReleaseBaseURL   = ""
	TestReleasePublicKey = ""
)

// ReleaseBase is where releases are downloaded from.
func ReleaseBase() string {
	if TestReleaseBaseURL != "" {
		return strings.TrimSuffix(TestReleaseBaseURL, "/")
	}
	return "https://github.com/" + brand.GitHubOrg + "/" + brand.GitHubRepo + "/releases"
}

// ReleasePublicKey is the minisign key that verifies release manifests.
func ReleasePublicKey() string {
	if TestReleasePublicKey != "" {
		return TestReleasePublicKey
	}
	return brand.MinisignPublicKey
}

// IsTestBuild reports whether a test override is linked in, so the agent
// can say so loudly at start.
func IsTestBuild() bool { return TestReleaseBaseURL != "" || TestReleasePublicKey != "" }
