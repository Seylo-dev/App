package localapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"

	"github.com/seylo-dev/app/go/internal/datadir"
	"github.com/seylo-dev/app/go/internal/stub"
)

// Available reports whether an agent socket exists at socket.
func Available(socket string) bool {
	info, err := os.Stat(socket)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

// Client talks to the local agent.
type Client struct {
	socket string
	http   *http.Client
}

// NewClient returns a client for the agent socket of layout.
func NewClient(layout datadir.Layout) *Client {
	return NewSocketClient(layout.AgentSocket())
}

// NewSocketClient returns a client for the agent socket at path.
func NewSocketClient(socket string) *Client {
	dialer := &net.Dialer{}
	return &Client{
		socket: socket,
		http: &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socket)
			},
		}},
	}
}

// Socket is the socket path the client uses.
func (c *Client) Socket() string { return c.socket }

// Status reports the node, its panel connection and its services.
func (c *Client) Status(ctx context.Context) (NodeStatus, error) {
	var s NodeStatus
	return s, c.do(ctx, http.MethodGet, "/v1/status", &s)
}

// Version reports the running agent's version.
func (c *Client) Version(ctx context.Context) (VersionInfo, error) {
	var v VersionInfo
	return v, c.do(ctx, http.MethodGet, "/v1/version", &v)
}

// StartPanel starts the Panel project's panel service.
func (c *Client) StartPanel(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/panel/start", nil)
}

// PanelStatus reports the panel service.
func (c *Client) PanelStatus(ctx context.Context) (PanelStatus, error) {
	var s PanelStatus
	return s, c.do(ctx, http.MethodGet, "/v1/panel", &s)
}

// PanelLogs writes the panel service's logs to w.
func (c *Client) PanelLogs(ctx context.Context, opts LogsOptions, w io.Writer) error {
	q := url.Values{"tail": {strconv.Itoa(opts.Tail)}, "follow": {strconv.FormatBool(opts.Follow)}}
	resp, err := c.request(ctx, http.MethodGet, "/v1/panel/logs?"+q.Encode())
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp); err != nil {
		return err
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func (c *Client) request(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://agent"+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("talking to the agent at %s: %w", c.socket, err)
	}
	return resp, nil
}

func (c *Client) do(ctx context.Context, method, path string, out any) error {
	resp, err := c.request(ctx, method, path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkResponse(resp); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decoding the agent's answer: %w", err)
	}
	return nil
}

// checkResponse turns an error body into an error; NOT_IMPLEMENTED stays
// recognizable with errors.Is(err, stub.ErrNotImplemented).
func checkResponse(resp *http.Response) error {
	if resp.StatusCode < 300 {
		return nil
	}
	var body apiError
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body); err != nil || body.Error.Message == "" {
		return fmt.Errorf("agent answered %s", resp.Status)
	}
	if body.Error.Code == "NOT_IMPLEMENTED" {
		return &remoteNotImplemented{msg: body.Error.Message}
	}
	return errors.New(body.Error.Message)
}

type remoteNotImplemented struct{ msg string }

func (e *remoteNotImplemented) Error() string        { return e.msg }
func (e *remoteNotImplemented) Is(target error) bool { return target == stub.ErrNotImplemented }
