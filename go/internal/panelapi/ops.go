package panelapi

import (
	"context"
	"fmt"
	"strings"
)

// Shapes of the op outputs the CLI reads (contracts in
// packages/ops/src/ops/*.ts). Only the fields the CLI uses are declared.

// Viewer is auth.whoami's viewer.
type Viewer struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// Project is a projects.list row.
type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Protected bool   `json:"protected"`
}

// Service is a services.list row.
type Service struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
}

// Deployment is deployments.Deployment.
type Deployment struct {
	ID         string `json:"id"`
	ServiceID  string `json:"serviceId"`
	Generation int    `json:"generation"`
	Status     string `json:"status"`
	Live       bool   `json:"live"`
	Error      string `json:"error"`
}

// Finished reports whether the deployment reached a final status.
func (d Deployment) Finished() bool {
	switch d.Status {
	case "live", "failed", "cancelled", "superseded":
		return true
	}
	return false
}

// LogLine is deployments.LogLine.
type LogLine struct {
	Seq   int    `json:"seq"`
	TS    string `json:"ts"`
	Step  string `json:"step"`
	Text  string `json:"text"`
	Error bool   `json:"error"`
}

// LogEntry is logs.LogEntry.
type LogEntry struct {
	Time       string `json:"time"`
	Stream     string `json:"stream"`
	NodeID     string `json:"nodeId"`
	Generation int    `json:"generation"`
	Line       string `json:"line"`
}

// StreamTicket is logs.StreamTicket.
type StreamTicket struct {
	URL       string `json:"url"`
	Ticket    string `json:"ticket"`
	ExpiresAt string `json:"expiresAt"`
}

// TimedExpose is exposures.TimedExpose.
type TimedExpose struct {
	ID        string `json:"id"`
	Host      string `json:"host"`
	Port      *int   `json:"port"`
	ExpiresAt string `json:"expiresAt"`
}

// Tunnel is tunnels.Tunnel.
type Tunnel struct {
	Enabled bool    `json:"enabled"`
	State   string  `json:"state"`
	URL     *string `json:"url"`
	Error   *string `json:"error"`
}

// Whoami verifies the credentials.
func (c *Client) Whoami(ctx context.Context) (Viewer, error) {
	var out struct {
		Viewer Viewer `json:"viewer"`
	}
	err := c.Query(ctx, "auth.whoami", struct{}{}, &out)
	return out.Viewer, err
}

func (c *Client) projects(ctx context.Context) ([]Project, error) {
	var out struct {
		Projects []Project `json:"projects"`
	}
	err := c.Query(ctx, "projects.list", struct{}{}, &out)
	return out.Projects, err
}

func (c *Client) services(ctx context.Context, projectID string) ([]Service, error) {
	var out struct {
		Services []Service `json:"services"`
	}
	err := c.Query(ctx, "services.list", map[string]string{"projectId": projectID}, &out)
	return out.Services, err
}

// ServiceRef names a service as "<project>/<service>", as a bare service
// name when it is unique across your projects, or by its id.
type ServiceRef string

// Resolve finds the service a reference names.
func (c *Client) Resolve(ctx context.Context, ref ServiceRef) (Service, error) {
	s := strings.TrimSpace(string(ref))
	projectName, serviceName, qualified := strings.Cut(s, "/")
	if !qualified {
		serviceName, projectName = s, ""
	}
	if serviceName == "" {
		return Service{}, fmt.Errorf("%q is not a service: use <project>/<service>", ref)
	}
	projects, err := c.projects(ctx)
	if err != nil {
		return Service{}, err
	}
	var matches []Service
	var projectFound bool
	for _, p := range projects {
		if qualified && !strings.EqualFold(p.Name, projectName) && p.ID != projectName {
			continue
		}
		projectFound = true
		list, err := c.services(ctx, p.ID)
		if err != nil {
			return Service{}, err
		}
		for _, svc := range list {
			if svc.Name == serviceName || svc.ID == serviceName {
				matches = append(matches, svc)
			}
		}
	}
	switch {
	case qualified && !projectFound:
		return Service{}, fmt.Errorf("no project named %q (or you cannot see it)", projectName)
	case len(matches) == 0:
		return Service{}, fmt.Errorf("no service %q found", ref)
	case len(matches) > 1:
		return Service{}, fmt.Errorf("%q matches services in %d projects: use <project>/%s", serviceName, len(matches), serviceName)
	}
	return matches[0], nil
}
