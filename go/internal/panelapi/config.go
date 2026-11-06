package panelapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
)

// DefaultProfile names the credentials used when no --profile is given.
const DefaultProfile = "default"

// Environment variables that override the saved profile (CI, scripts).
var (
	EnvPanelURL = strings.ToUpper(brand.Slug) + "_PANEL_URL"
	EnvToken    = strings.ToUpper(brand.Slug) + "_TOKEN"
	EnvConfig   = strings.ToUpper(brand.Slug) + "_CONFIG"
)

// Profile is one saved panel login.
type Profile struct {
	PanelURL string    `json:"panelUrl"`
	Token    string    `json:"token"`
	Email    string    `json:"email,omitempty"`
	SavedAt  time.Time `json:"savedAt"`
}

// Config is the laptop CLI's config file.
type Config struct {
	// Current is the profile used when none is named.
	Current  string             `json:"current,omitempty"`
	Profiles map[string]Profile `json:"profiles"`
}

// ErrNotLoggedIn: no profile and no environment credentials.
var ErrNotLoggedIn = errors.New("not signed in to a panel: run `" + brand.Slug + " login <panel-url>` first")

// ConfigPath is $SEYLO_CONFIG, else $XDG_CONFIG_HOME/seylo/config.json,
// else ~/.config/seylo/config.json (also on macOS, like most CLIs).
func ConfigPath() (string, error) {
	if p := os.Getenv(EnvConfig); p != "" {
		return p, nil
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("finding the config folder: %w", err)
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, brand.Slug, "config.json"), nil
}

// LoadConfig reads path; a missing file is an empty config.
func LoadConfig(path string) (*Config, error) {
	cfg := &Config{Profiles: map[string]Profile{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string]Profile{}
	}
	return cfg, nil
}

// Save writes the config with mode 0600 in a 0700 folder: it holds API
// keys.
func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Profile returns the named profile ("" means the current one).
func (c *Config) Profile(name string) (string, Profile, bool) {
	if name == "" {
		name = c.Current
	}
	if name == "" {
		name = DefaultProfile
	}
	p, ok := c.Profiles[name]
	return name, p, ok
}

// Names lists the profiles in order.
func (c *Config) Names() []string {
	names := make([]string, 0, len(c.Profiles))
	for n := range c.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Open returns a client for profile ("" = current), with the environment
// variables taking precedence when both are set.
func Open(profile string) (*Client, error) {
	if url, token := os.Getenv(EnvPanelURL), os.Getenv(EnvToken); url != "" && token != "" {
		return NewClient(url, token)
	}
	path, err := ConfigPath()
	if err != nil {
		return nil, err
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return nil, err
	}
	name, p, ok := cfg.Profile(profile)
	if !ok {
		if profile != "" && profile != DefaultProfile {
			return nil, fmt.Errorf("no saved login named %q (have: %s)", name, strings.Join(cfg.Names(), ", "))
		}
		return nil, ErrNotLoggedIn
	}
	return NewClient(p.PanelURL, p.Token)
}
