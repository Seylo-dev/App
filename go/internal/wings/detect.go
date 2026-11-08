package wings

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"time"

	"go.yaml.in/yaml/v3"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Detector finds a Wings installation.
type Detector interface {
	// Detect returns nil when Wings is not installed.
	Detect(ctx context.Context) (*agentv1.WingsInfo, error)
}

// CPUPriority applies the "game servers first" setting.
type CPUPriority interface {
	// SetGamesFirst lowers (or restores) the CPU weight of seylo.slice.
	SetGamesFirst(ctx context.Context, enabled bool) error
}

// ForeignRoutesFeature is what a Wings fork build advertises (GET
// /api/system "features" or "proxy.features") when its route pruning
// leaves seylo-* files alone.
const ForeignRoutesFeature = "foreign-routes"

// Where Wings keeps its config and unit, relative to the file system root.
var (
	configPaths = []string{"etc/pelican/config.yml", "etc/pterodactyl/config.yml"}
	unitPaths   = []string{"etc/systemd/system/wings.service", "lib/systemd/system/wings.service", "usr/lib/systemd/system/wings.service"}
)

// Fork defaults (config/config_proxy.go in the Wings fork) for a config
// file without a proxy section.
const (
	defaultProxyDataDir   = "/var/lib/pelican/proxy"
	defaultProxyContainer = "nexthost-proxy"
	defaultWingsNetwork   = "pelican_nw"
)

// Installation is what the files say about Wings on this node.
type Installation struct {
	ConfigPath string
	// Proxy is set when the Wings fork runs its Traefik here; then route
	// files go to Proxy.DynamicDir.
	Proxy   *Proxy
	Network string
	api     apiConfig
	token   string
}

// Proxy is the Wings fork's Traefik.
type Proxy struct {
	Container  string
	DataDir    string
	DynamicDir string
}

// AcmeFile is the fork Traefik's acme.json.
func (p *Proxy) AcmeFile() string { return filepath.Join(p.DataDir, "acme.json") }

type apiConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
	SSL  struct {
		Enabled bool `yaml:"enabled"`
	} `yaml:"ssl"`
}

type wingsConfig struct {
	Token  string    `yaml:"token"`
	API    apiConfig `yaml:"api"`
	Docker struct {
		Network struct {
			Name string `yaml:"name"`
		} `yaml:"network"`
	} `yaml:"docker"`
	Proxy *struct {
		Enabled       *bool  `yaml:"enabled"`
		ContainerName string `yaml:"container_name"`
		DataDir       string `yaml:"data_dir"`
	} `yaml:"proxy"`
}

// defaultClient asks the local Wings API. One request every few minutes
// needs no pooled connection: Wings' server has no idle timeout, so a
// kept-alive socket (and its transport's goroutines) would stay open on
// both ends, and a new transport per call leaked one per Detect.
var defaultClient = &http.Client{
	Timeout: 3 * time.Second,
	Transport: &http.Transport{
		DisableKeepAlives: true,
		// The certificate names the node's domain, not the loopback
		// address this request uses.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // loopback only
	},
}

// FileDetector reads Wings' files (and asks its local API for the version
// and features).
type FileDetector struct {
	// Root is the file system root ("/" in production).
	Root string
	// HTTP calls the local Wings API; nil uses a 3s client.
	HTTP *http.Client
}

// NewDetector returns a detector for the real file system.
func NewDetector() *FileDetector { return &FileDetector{Root: "/"} }

func (d *FileDetector) path(rel string) string { return filepath.Join(d.Root, rel) }

// Find reads the installation from files only (fast, no network). It
// returns nil, nil when Wings is not installed.
func (d *FileDetector) Find() (*Installation, error) {
	var inst *Installation
	for _, rel := range configPaths {
		raw, err := os.ReadFile(d.path(rel))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("reading Wings config: %w", err)
		}
		var cfg wingsConfig
		if err := yaml.Unmarshal(raw, &cfg); err != nil {
			return nil, fmt.Errorf("parsing %s: %w", rel, err)
		}
		inst = &Installation{ConfigPath: "/" + rel, Network: cfg.Docker.Network.Name, api: cfg.API, token: cfg.Token}
		if inst.Network == "" {
			inst.Network = defaultWingsNetwork
		}
		enabled := cfg.Proxy == nil || cfg.Proxy.Enabled == nil || *cfg.Proxy.Enabled
		dataDir, container := defaultProxyDataDir, defaultProxyContainer
		if cfg.Proxy != nil && cfg.Proxy.DataDir != "" {
			dataDir = cfg.Proxy.DataDir
		}
		if cfg.Proxy != nil && cfg.Proxy.ContainerName != "" {
			container = cfg.Proxy.ContainerName
		}
		// Upstream Wings has no proxy: only a fork that made its dynamic
		// folder counts.
		dynamic := filepath.Join(dataDir, "dynamic")
		if st, err := os.Stat(d.path(dynamic)); enabled && err == nil && st.IsDir() {
			inst.Proxy = &Proxy{Container: container, DataDir: dataDir, DynamicDir: dynamic}
		}
		break
	}
	if inst == nil {
		for _, rel := range unitPaths {
			if _, err := os.Stat(d.path(rel)); err == nil {
				// A unit without a config: installed, not configured yet.
				return &Installation{}, nil
			}
		}
		return nil, nil
	}
	return inst, nil
}

// systemInfo is the part of GET /api/system the agent reads.
type systemInfo struct {
	Version  string   `json:"version"`
	Features []string `json:"features"`
	Proxy    struct {
		Features []string `json:"features"`
	} `json:"proxy"`
}

// Detect implements Detector.
func (d *FileDetector) Detect(ctx context.Context) (*agentv1.WingsInfo, error) {
	inst, err := d.Find()
	if err != nil || inst == nil {
		return nil, err
	}
	info := &agentv1.WingsInfo{}
	if inst.Proxy != nil {
		info.TraefikDynamicDir = inst.Proxy.DynamicDir
		// The panel trusts forwarded headers only from this container.
		info.ProxyContainer = inst.Proxy.Container
	}
	if sys, err := d.system(ctx, inst); err == nil {
		info.Version = sys.Version
		info.ForeignRoutesSupported = slices.Contains(sys.Features, ForeignRoutesFeature) || slices.Contains(sys.Proxy.Features, ForeignRoutesFeature)
	}
	return info, nil
}

// system asks the local Wings API, over loopback, for its version and
// features.
func (d *FileDetector) system(ctx context.Context, inst *Installation) (*systemInfo, error) {
	if inst.token == "" || inst.api.Port == 0 {
		return nil, errors.New("wings API not configured")
	}
	host := inst.api.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if inst.api.SSL.Enabled {
		scheme = "https"
	}
	client := d.HTTP
	if client == nil {
		client = defaultClient
	}
	url := fmt.Sprintf("%s://%s/api/system", scheme, net.JoinHostPort(host, strconv.Itoa(inst.api.Port)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+inst.token)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wings API answered %d", resp.StatusCode)
	}
	var sys systemInfo
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&sys); err != nil {
		return nil, err
	}
	return &sys, nil
}

var _ Detector = (*FileDetector)(nil)
