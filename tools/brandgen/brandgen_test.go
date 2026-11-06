package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validBrand() Brand {
	return Brand{
		DisplayName:       "Seylo",
		Slug:              "seylo",
		DataDir:           "/var/lib/seylo",
		InstallURL:        "install.seylo.dev",
		DocsURL:           "https://seylo.dev/docs",
		SiteURL:           "https://seylo.dev",
		GitHubOrg:         "Seylo-dev",
		GitHubRepo:        "App",
		Image:             "ghcr.io/seylo-dev/seylo",
		OAuthClientID:     "PLACEHOLDER_GITHUB_OAUTH_CLIENT_ID",
		MinisignPublicKey: "PLACEHOLDER_MINISIGN_PUBLIC_KEY",
	}
}

func TestValidateAcceptsRepoBrand(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "brand", "brand.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseBrand(data); err != nil {
		t.Fatalf("repo brand.json is invalid: %v", err)
	}
}

func TestValidateRejectsBadValues(t *testing.T) {
	tests := map[string]func(*Brand){
		"uppercase slug":     func(b *Brand) { b.Slug = "Seylo" },
		"relative data dir":  func(b *Brand) { b.DataDir = "var/lib/seylo" },
		"unclean data dir":   func(b *Brand) { b.DataDir = "/var/lib/seylo/" },
		"install with https": func(b *Brand) { b.InstallURL = "https://install.seylo.dev" },
		"http site":          func(b *Brand) { b.SiteURL = "http://seylo.dev" },
		"trailing slash":     func(b *Brand) { b.DocsURL = "https://seylo.dev/docs/" },
		"image with tag":     func(b *Brand) { b.Image = "ghcr.io/seylo-dev/seylo:latest" },
		"quote in name":      func(b *Brand) { b.DisplayName = `Sey"lo` },
		"dollar in name":     func(b *Brand) { b.DisplayName = "Sey$lo" },
		"empty client id":    func(b *Brand) { b.OAuthClientID = "" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			b := validBrand()
			mutate(&b)
			if err := b.Validate(); err == nil {
				t.Fatal("expected a validation error")
			}
		})
	}
}

func TestParseRejectsUnknownKeys(t *testing.T) {
	_, err := ParseBrand([]byte(`{"displayName":"Seylo","slugg":"seylo"}`))
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown field error, got %v", err)
	}
}

func TestRenderContainsEveryValue(t *testing.T) {
	b := validBrand()
	outputs, err := Render(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(outputs) != 3 {
		t.Fatalf("expected 3 outputs, got %d", len(outputs))
	}
	for _, o := range outputs {
		for _, f := range b.fields() {
			if !strings.Contains(string(o.Content), f.Value) {
				t.Errorf("%s is missing %s", o.Path, f.TS)
			}
		}
		if !strings.Contains(string(o.Content), "DO NOT EDIT") {
			t.Errorf("%s has no generated-code header", o.Path)
		}
	}
}

func TestCheckDetectsStaleAndFreshFiles(t *testing.T) {
	root := t.TempDir()
	outputs, err := Render(validBrand())
	if err != nil {
		t.Fatal(err)
	}

	if err := checkOutputs(root, outputs); !errors.Is(err, ErrStale) {
		t.Fatalf("missing files must be stale, got %v", err)
	}
	if err := writeOutputs(root, outputs); err != nil {
		t.Fatal(err)
	}
	if err := checkOutputs(root, outputs); err != nil {
		t.Fatalf("fresh files reported stale: %v", err)
	}

	edited := filepath.Join(root, "installer", "brand.env")
	if err := os.WriteFile(edited, []byte("BRAND_SLUG='x'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err = checkOutputs(root, outputs)
	if !errors.Is(err, ErrStale) || !strings.Contains(err.Error(), "installer/brand.env") {
		t.Fatalf("edited file not reported: %v", err)
	}
}
