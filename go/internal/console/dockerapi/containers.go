package dockerapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/internal/docker"
)

// Container is one row of a container listing.
type Container struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	Labels map[string]string `json:"Labels"`
	// State is "created", "running", "paused", "restarting", "removing",
	// "exited" or "dead".
	State   string `json:"State"`
	Created int64  `json:"Created"`
}

// Running reports whether the container's process is up.
func (c Container) Running() bool { return c.State == "running" }

// ServiceID is the seylo.service label.
func (c Container) ServiceID() string { return c.Labels[docker.LabelService] }

// Generation is the seylo.generation label, 0 when missing.
func (c Container) Generation() uint64 {
	g, _ := strconv.ParseUint(c.Labels[docker.LabelGeneration], 10, 64)
	return g
}

// Replica is the seylo.replica label, 0 when missing.
func (c Container) Replica() uint32 {
	r, _ := strconv.ParseUint(c.Labels[docker.LabelReplica], 10, 32)
	return uint32(r)
}

// Name is the container name without the leading slash.
func (c Container) Name() string {
	if len(c.Names) == 0 {
		return ""
	}
	return strings.TrimPrefix(c.Names[0], "/")
}

// ListContainers lists managed containers (seylo.managed=true) that carry
// every label in labels. all includes stopped ones.
func (c *Client) ListContainers(ctx context.Context, all bool, labels map[string]string) ([]Container, error) {
	want := map[string]string{docker.LabelManaged: "true"}
	for k, v := range labels {
		want[k] = v
	}
	q := url.Values{"filters": {labelFilters(want)}}
	if all {
		q.Set("all", "1")
	}
	var out []Container
	if err := c.getJSON(ctx, http.MethodGet, "/containers/json", q, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ContainerJSON is the part of an inspect answer we read.
type ContainerJSON struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Created string `json:"Created"`
	Config  struct {
		Tty        bool              `json:"Tty"`
		OpenStdin  bool              `json:"OpenStdin"`
		User       string            `json:"User"`
		WorkingDir string            `json:"WorkingDir"`
		Labels     map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Pid        int    `json:"Pid"`
		ExitCode   int    `json:"ExitCode"`
		OOMKilled  bool   `json:"OOMKilled"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
	} `json:"State"`
	HostConfig struct {
		LogConfig struct {
			Type string `json:"Type"`
		} `json:"LogConfig"`
	} `json:"HostConfig"`
}

// FinishedAt parses State.FinishedAt (zero when the container never
// stopped).
func (j *ContainerJSON) FinishedAt() time.Time {
	t, err := time.Parse(time.RFC3339Nano, j.State.FinishedAt)
	if err != nil || t.Year() < 2000 {
		return time.Time{}
	}
	return t
}

// Inspect reads one container.
func (c *Client) Inspect(ctx context.Context, id string) (*ContainerJSON, error) {
	var out ContainerJSON
	if err := c.getJSON(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ErrNoContainer means a service has no running container (stopped,
// deploying, or not on this node).
var ErrNoContainer = fmt.Errorf("no running container")

// ServiceContainer picks the running container of a service: the given id
// (full id, short id or name) when set, else the newest generation's first
// replica. A container id that belongs to another service is treated as
// not found, so callers cannot reach other services through it.
func (c *Client) ServiceContainer(ctx context.Context, serviceID, containerID string) (Container, error) {
	list, err := c.ListContainers(ctx, false, map[string]string{docker.LabelService: serviceID})
	if err != nil {
		return Container{}, err
	}
	list = slices.DeleteFunc(list, func(x Container) bool { return !x.Running() })
	if containerID != "" {
		for _, x := range list {
			if x.ID == containerID || (len(containerID) >= 12 && strings.HasPrefix(x.ID, containerID)) || x.Name() == containerID {
				return x, nil
			}
		}
		return Container{}, fmt.Errorf("%w: container %q of service %q", ErrNoContainer, containerID, serviceID)
	}
	if len(list) == 0 {
		return Container{}, fmt.Errorf("%w: service %q", ErrNoContainer, serviceID)
	}
	slices.SortFunc(list, func(a, b Container) int {
		if a.Generation() != b.Generation() {
			if a.Generation() > b.Generation() {
				return -1
			}
			return 1
		}
		return int(a.Replica()) - int(b.Replica())
	})
	return list[0], nil
}

// LogsOptions selects container output.
type LogsOptions struct {
	Follow     bool
	Timestamps bool
	// Since and Until are exclusive/inclusive bounds; zero means none.
	Since time.Time
	Until time.Time
	// Tail is the number of last lines, 0 means all.
	Tail int
}

// Logs streams a container's output. Without a TTY the body is multiplexed
// (see FrameReader); with one it is raw bytes.
func (c *Client) Logs(ctx context.Context, id string, o LogsOptions) (io.ReadCloser, error) {
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}}
	if o.Follow {
		q.Set("follow", "1")
	}
	if o.Timestamps {
		q.Set("timestamps", "1")
	}
	if !o.Since.IsZero() {
		q.Set("since", unixNano(o.Since))
	}
	if !o.Until.IsZero() {
		q.Set("until", unixNano(o.Until))
	}
	if o.Tail > 0 {
		q.Set("tail", strconv.Itoa(o.Tail))
	}
	resp, err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/logs", q, nil)
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// unixNano formats t the way Docker's since/until accept sub-second times.
func unixNano(t time.Time) string {
	return fmt.Sprintf("%d.%09d", t.Unix(), t.Nanosecond())
}

// Attach connects to a running container's stdin and output (no history).
func (c *Client) Attach(ctx context.Context, id string) (*Stream, error) {
	q := url.Values{"stream": {"1"}, "stdin": {"1"}, "stdout": {"1"}, "stderr": {"1"}}
	return c.hijack(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/attach", q, nil)
}

// Resize changes the TTY size of a container started with a TTY.
func (c *Client) Resize(ctx context.Context, id string, rows, cols uint32) error {
	q := url.Values{"h": {strconv.Itoa(int(rows))}, "w": {strconv.Itoa(int(cols))}}
	return c.getJSON(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/resize", q, nil, nil)
}

// Wait blocks until the container is not running and returns its exit code.
func (c *Client) Wait(ctx context.Context, id string) (int, error) {
	var out struct {
		StatusCode int `json:"StatusCode"`
		Error      *struct {
			Message string `json:"Message"`
		} `json:"Error"`
	}
	q := url.Values{"condition": {"not-running"}}
	if err := c.getJSON(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/wait", q, nil, &out); err != nil {
		return 0, err
	}
	if out.Error != nil && out.Error.Message != "" {
		return out.StatusCode, fmt.Errorf("docker wait: %s", out.Error.Message)
	}
	return out.StatusCode, nil
}

// Event is one container event.
type Event struct {
	// Action is "start", "die", "destroy", ...
	Action      string
	ContainerID string
	Labels      map[string]string
	Time        time.Time
}

// Events streams start, die and destroy events of managed containers until
// ctx ends. The error channel gets one value when the stream breaks.
func (c *Client) Events(ctx context.Context) (<-chan Event, <-chan error) {
	events := make(chan Event, 64)
	errc := make(chan error, 1)
	go func() {
		defer close(events)
		filters, _ := json.Marshal(map[string][]string{
			"type":  {"container"},
			"label": {docker.LabelManaged + "=true"},
			"event": {"start", "die", "destroy"},
		})
		resp, err := c.do(ctx, http.MethodGet, "/events", url.Values{"filters": {string(filters)}}, nil)
		if err != nil {
			errc <- err
			return
		}
		defer resp.Body.Close()
		dec := json.NewDecoder(resp.Body)
		for {
			var m struct {
				Action string `json:"Action"`
				Actor  struct {
					ID         string            `json:"ID"`
					Attributes map[string]string `json:"Attributes"`
				} `json:"Actor"`
				TimeNano int64 `json:"timeNano"`
			}
			if err := dec.Decode(&m); err != nil {
				if ctx.Err() != nil {
					err = ctx.Err()
				}
				errc <- err
				return
			}
			ev := Event{Action: m.Action, ContainerID: m.Actor.ID, Labels: m.Actor.Attributes, Time: time.Unix(0, m.TimeNano)}
			select {
			case events <- ev:
			case <-ctx.Done():
				errc <- ctx.Err()
				return
			}
		}
	}()
	return events, errc
}

// CreateOptions is a minimal container definition, for integration tests.
type CreateOptions struct {
	Name      string
	Image     string
	Cmd       []string
	Env       []string
	Labels    map[string]string
	Tty       bool
	OpenStdin bool
	User      string
	Binds     []string
}

// Create creates a container with the managed label added. Production
// containers are created by package docker; this is for tests.
func (c *Client) Create(ctx context.Context, o CreateOptions) (string, error) {
	labels := map[string]string{docker.LabelManaged: "true", docker.LabelTraefikEnable: "false"}
	for k, v := range o.Labels {
		labels[k] = v
	}
	body := map[string]any{
		"Image": o.Image, "Cmd": o.Cmd, "Env": o.Env, "Labels": labels, "Tty": o.Tty,
		"OpenStdin": o.OpenStdin, "AttachStdin": false, "User": o.User,
		"HostConfig": map[string]any{"Binds": o.Binds},
	}
	var out struct {
		ID string `json:"Id"`
	}
	if err := c.getJSON(ctx, http.MethodPost, "/containers/create", url.Values{"name": {o.Name}}, body, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// Start starts a created container.
func (c *Client) Start(ctx context.Context, id string) error {
	return c.getJSON(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil, nil)
}

// Remove force-removes a container with its anonymous volumes.
func (c *Client) Remove(ctx context.Context, id string) error {
	q := url.Values{"force": {"1"}, "v": {"1"}}
	err := c.getJSON(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id), q, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	return err
}

// PullImage pulls an image if it is not present, for tests.
func (c *Client) PullImage(ctx context.Context, ref string) error {
	if err := c.getJSON(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, nil); err == nil {
		return nil
	}
	resp, err := c.do(ctx, http.MethodPost, "/images/create", url.Values{"fromImage": {ref}}, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	dec := json.NewDecoder(resp.Body)
	for {
		var m struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&m); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		if m.Error != "" {
			return fmt.Errorf("pulling %s: %s", ref, m.Error)
		}
	}
}

// UserOrRoot is the user a container process runs as: the configured user,
// or "root" when the image sets none.
func UserOrRoot(user string) string {
	if user == "" {
		return "root"
	}
	return user
}

// DirOrRoot is a container's working directory, "/" when the image sets none.
func DirOrRoot(dir string) string {
	if dir == "" {
		return "/"
	}
	return dir
}
