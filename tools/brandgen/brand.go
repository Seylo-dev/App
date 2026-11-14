package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// Brand mirrors brand/brand.json. Unknown keys are rejected so a typo in the
// JSON fails loudly instead of silently producing an empty constant.
type Brand struct {
	DisplayName       string `json:"displayName"`
	Slug              string `json:"slug"`
	DataDir           string `json:"dataDir"`
	InstallURL        string `json:"installUrl"`
	DocsURL           string `json:"docsUrl"`
	SiteURL           string `json:"siteUrl"`
	GitHubOrg         string `json:"githubOrg"`
	GitHubRepo        string `json:"githubRepo"`
	Image             string `json:"image"`
	OAuthClientID     string `json:"oauthClientId"`
	MinisignPublicKey string `json:"minisignPublicKey"`
	// TemplatesRepo is the repository under GitHubOrg that holds the
	// template catalog and publishes it signed (release tag "catalog").
	TemplatesRepo string `json:"templatesRepo"`
	// TemplatesMinisignPublicKey verifies that catalog. It is a key of its
	// own, not the release key: the catalog is signed on every merge in a
	// repository that takes outside pull requests.
	TemplatesMinisignPublicKey string `json:"templatesMinisignPublicKey"`
}

// PlaceholderPrefix marks values that are not set yet. Consumers
// check for it (for example, the panel hides GitHub sign-in while the OAuth
// client id is a placeholder) instead of failing at runtime.
const PlaceholderPrefix = "PLACEHOLDER_"

// field describes one brand value and the identifier it gets in each
// generated output. The order here is the order in every output file.
type field struct {
	Go, TS, Env string
	Doc         string
	Value       string
}

func (b Brand) fields() []field {
	return []field{
		{"DisplayName", "displayName", "BRAND_DISPLAY_NAME", "DisplayName is the product name shown to people.", b.DisplayName},
		{"Slug", "slug", "BRAND_SLUG", "Slug names the binary, labels, networks, systemd units and Docker resources.", b.Slug},
		{"DataDir", "dataDir", "BRAND_DATA_DIR", "DataDir holds everything a node stores, so one folder exports all of it.", b.DataDir},
		{"InstallURL", "installUrl", "BRAND_INSTALL_URL", "InstallURL is the host serving install.sh, without a scheme.", b.InstallURL},
		{"DocsURL", "docsUrl", "BRAND_DOCS_URL", "DocsURL is the public documentation root.", b.DocsURL},
		{"SiteURL", "siteUrl", "BRAND_SITE_URL", "SiteURL hosts the landing page, telemetry and troubleshoot reports.", b.SiteURL},
		{"GitHubOrg", "githubOrg", "BRAND_GITHUB_ORG", "GitHubOrg owns the public repository and the OAuth App.", b.GitHubOrg},
		{"GitHubRepo", "githubRepo", "BRAND_GITHUB_REPO", "GitHubRepo is the public repository name under GitHubOrg.", b.GitHubRepo},
		{"Image", "image", "BRAND_IMAGE", "Image is the panel container image, without a tag.", b.Image},
		{"OAuthClientID", "oauthClientId", "BRAND_OAUTH_CLIENT_ID", "OAuthClientID is the public client id of the GitHub OAuth App used for device-flow sign-in.", b.OAuthClientID},
		{"MinisignPublicKey", "minisignPublicKey", "BRAND_MINISIGN_PUBLIC_KEY", "MinisignPublicKey verifies signed release manifests.", b.MinisignPublicKey},
		{"TemplatesRepo", "templatesRepo", "BRAND_TEMPLATES_REPO", "TemplatesRepo is the repository under GitHubOrg that publishes the signed template catalog.", b.TemplatesRepo},
		{"TemplatesMinisignPublicKey", "templatesMinisignPublicKey", "BRAND_TEMPLATES_MINISIGN_PUBLIC_KEY", "TemplatesMinisignPublicKey verifies the signed template catalog (a key of its own, not the release key).", b.TemplatesMinisignPublicKey},
	}
}

var (
	slugRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}$`)
	githubRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)
	hostRe   = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)
	imageRe  = regexp.MustCompile(`^[a-z0-9.-]+(/[a-z0-9._-]+)+$`)
)

// ParseBrand decodes and validates brand.json.
func ParseBrand(data []byte) (Brand, error) {
	var b Brand
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return Brand{}, fmt.Errorf("decode brand.json: %w", err)
	}
	if err := b.Validate(); err != nil {
		return Brand{}, err
	}
	return b, nil
}

// Validate checks every value against the shape its consumers assume. All
// problems are reported at once so one run fixes them all.
func (b Brand) Validate() error {
	var errs []error
	check := func(ok bool, format string, args ...any) {
		if !ok {
			errs = append(errs, fmt.Errorf(format, args...))
		}
	}

	for _, f := range b.fields() {
		check(strings.TrimSpace(f.Value) != "", "%s is required", f.TS)
		check(!strings.ContainsAny(f.Value, "'\"\\\n`$"), "%s must not contain quotes, backslashes, backticks, $ or newlines", f.TS)
	}
	check(slugRe.MatchString(b.Slug), "slug %q must match %s", b.Slug, slugRe)
	check(path.IsAbs(b.DataDir) && path.Clean(b.DataDir) == b.DataDir, "dataDir %q must be a clean absolute path", b.DataDir)
	check(hostRe.MatchString(b.InstallURL), "installUrl %q must be a bare host name (no scheme or path)", b.InstallURL)
	check(isHTTPSURL(b.DocsURL), "docsUrl %q must be an https URL", b.DocsURL)
	check(isHTTPSURL(b.SiteURL), "siteUrl %q must be an https URL", b.SiteURL)
	check(githubRe.MatchString(b.GitHubOrg), "githubOrg %q is not a valid GitHub name", b.GitHubOrg)
	check(githubRe.MatchString(b.GitHubRepo), "githubRepo %q is not a valid GitHub name", b.GitHubRepo)
	check(githubRe.MatchString(b.TemplatesRepo), "templatesRepo %q is not a valid GitHub name", b.TemplatesRepo)
	check(imageRe.MatchString(b.Image), "image %q must be a registry/path reference without a tag", b.Image)

	return errors.Join(errs...)
}

func isHTTPSURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && u.Host != "" && !strings.HasSuffix(s, "/")
}
