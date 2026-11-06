package nodecheck

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// DockerInfo is the part of the Engine's GET /info the checks read.
type DockerInfo struct {
	ServerVersion   string `json:"ServerVersion"`
	Driver          string `json:"Driver"`
	CgroupDriver    string `json:"CgroupDriver"`
	CgroupVersion   string `json:"CgroupVersion"`
	DockerRootDir   string `json:"DockerRootDir"`
	OperatingSystem string `json:"OperatingSystem"`
	KernelVersion   string `json:"KernelVersion"`
	Architecture    string `json:"Architecture"`
	Containers      int    `json:"Containers"`
	Images          int    `json:"Images"`
	// LiveRestoreEnabled keeps containers running while dockerd restarts.
	LiveRestoreEnabled bool `json:"LiveRestoreEnabled"`
	Warnings           []string
}

// DockerContainer is one row of GET /containers/json.
type DockerContainer struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

// Name is the container name without the leading slash.
func (c DockerContainer) Name() string {
	if len(c.Names) == 0 {
		return c.ID
	}
	return strings.TrimPrefix(c.Names[0], "/")
}

// DockerAPI is the read-only Docker access the checks and the
// troubleshoot report use.
type DockerAPI interface {
	Info(ctx context.Context) (*DockerInfo, error)
	// Containers lists containers (all states) matching Docker filters,
	// for example {"publish": ["80"]} or {"label": ["seylo.managed=true"]}.
	Containers(ctx context.Context, filters map[string][]string) ([]DockerContainer, error)
}

// DockerSocket reads the Engine API over its unix socket. It needs no
// Docker SDK: three GETs are all the checks use.
type DockerSocket struct {
	client *http.Client
}

// NewDockerSocket talks to socket, or to DOCKER_HOST (unix only) or
// /var/run/docker.sock when socket is empty.
func NewDockerSocket(socket string) *DockerSocket {
	if socket == "" {
		socket = "/var/run/docker.sock"
		if host, ok := strings.CutPrefix(os.Getenv("DOCKER_HOST"), "unix://"); ok && host != "" {
			socket = host
		}
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &DockerSocket{client: &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socket)
			},
		},
	}}
}

func (d *DockerSocket) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	res, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("docker %s: HTTP %d", path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(v)
}

func (d *DockerSocket) Info(ctx context.Context) (*DockerInfo, error) {
	var info DockerInfo
	if err := d.get(ctx, "/info", &info); err != nil {
		return nil, err
	}
	return &info, nil
}

func (d *DockerSocket) Containers(ctx context.Context, filters map[string][]string) ([]DockerContainer, error) {
	path := "/containers/json?all=1"
	if len(filters) > 0 {
		f, err := json.Marshal(filters)
		if err != nil {
			return nil, err
		}
		path += "&filters=" + url.QueryEscape(string(f))
	}
	var list []DockerContainer
	if err := d.get(ctx, path, &list); err != nil {
		return nil, err
	}
	return list, nil
}
