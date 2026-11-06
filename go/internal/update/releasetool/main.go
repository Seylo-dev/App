// Command releasetool writes a release's manifest.json from the built
// files (scripts/release-manifest.sh runs it after goreleaser). It is not
// part of the seylo binary.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/update"
)

func main() {
	var in update.ReleaseInput
	var out, platforms string
	flag.StringVar(&in.Version, "version", "", "release version, for example 0.9.4")
	flag.StringVar(&in.BinaryDir, "binaries", "dist", "folder with the agent binaries")
	flag.StringVar(&platforms, "platforms", "linux-amd64,linux-arm64", "comma-separated <goos>-<goarch> list")
	flag.StringVar(&in.DownloadBase, "download-base", "", "release download URL (default: the GitHub release of -version)")
	flag.StringVar(&in.PanelImage, "image", "", "panel image with its tag")
	flag.StringVar(&in.PanelDigest, "digest", "", "panel image index digest (sha256:...)")
	flag.StringVar(&in.Installer, "installer", "", "rendered install.sh")
	flag.StringVar(&in.ChangelogURL, "changelog", "", "release notes URL")
	flag.StringVar(&in.MinAgent, "min-agent", "", "oldest agent this release's panel accepts")
	flag.StringVar(&in.MinUpgradeFrom, "min-upgrade-from", "", "oldest version that may update straight to this one")
	flag.StringVar(&out, "out", "dist/"+update.ManifestFile, "where to write the manifest")
	flag.Parse()

	in.Slug = brand.Slug
	in.Platforms = strings.Split(platforms, ",")
	in.ReleasedAt = time.Now()
	if in.DownloadBase == "" {
		in.DownloadBase = strings.TrimSuffix(update.ReleaseURL(in.Version, "x"), "/x")
	}
	if in.ChangelogURL == "" {
		in.ChangelogURL = "https://github.com/" + brand.GitHubOrg + "/" + brand.GitHubRepo + "/releases/tag/v" + strings.TrimPrefix(in.Version, "v")
	}
	data, err := update.BuildManifest(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "releasetool:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(out, append(data, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "releasetool:", err)
		os.Exit(1)
	}
	fmt.Println("wrote", out)
}
