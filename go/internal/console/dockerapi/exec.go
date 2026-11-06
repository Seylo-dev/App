package dockerapi

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// ExecConfig describes a process started inside a container.
type ExecConfig struct {
	Cmd        []string
	Env        []string
	User       string
	WorkingDir string
	Tty        bool
	Stdin      bool
	// Rows and Cols set the initial TTY size (Tty only).
	Rows, Cols uint32
}

// ExecCreate prepares a process and returns the exec id.
func (c *Client) ExecCreate(ctx context.Context, containerID string, cfg ExecConfig) (string, error) {
	body := map[string]any{
		"AttachStdin": cfg.Stdin, "AttachStdout": true, "AttachStderr": true,
		"Tty": cfg.Tty, "Cmd": cfg.Cmd, "Env": cfg.Env, "User": cfg.User, "WorkingDir": cfg.WorkingDir,
	}
	if cfg.Tty && cfg.Rows > 0 && cfg.Cols > 0 {
		body["ConsoleSize"] = []uint32{cfg.Rows, cfg.Cols}
	}
	var out struct {
		ID string `json:"Id"`
	}
	if err := c.getJSON(ctx, http.MethodPost, "/containers/"+url.PathEscape(containerID)+"/exec", nil, body, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

// ExecStart starts a created exec and returns its stream. Without a TTY
// the output is multiplexed (FrameReader).
func (c *Client) ExecStart(ctx context.Context, execID string, tty bool, rows, cols uint32) (*Stream, error) {
	body := map[string]any{"Detach": false, "Tty": tty}
	if tty && rows > 0 && cols > 0 {
		body["ConsoleSize"] = []uint32{rows, cols}
	}
	return c.hijack(ctx, http.MethodPost, "/exec/"+url.PathEscape(execID)+"/start", nil, body)
}

// ExecResize changes an exec's TTY size.
func (c *Client) ExecResize(ctx context.Context, execID string, rows, cols uint32) error {
	q := url.Values{"h": {strconv.Itoa(int(rows))}, "w": {strconv.Itoa(int(cols))}}
	return c.getJSON(ctx, http.MethodPost, "/exec/"+url.PathEscape(execID)+"/resize", q, nil, nil)
}

// ExecState is the part of an exec inspect we read.
type ExecState struct {
	Running  bool `json:"Running"`
	ExitCode int  `json:"ExitCode"`
	Pid      int  `json:"Pid"`
}

// ExecInspect reads an exec's state.
func (c *Client) ExecInspect(ctx context.Context, execID string) (ExecState, error) {
	var out ExecState
	err := c.getJSON(ctx, http.MethodGet, "/exec/"+url.PathEscape(execID)+"/json", nil, nil, &out)
	return out, err
}
