package dockerapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// DefaultSocket is where Docker listens on Linux.
const DefaultSocket = "/var/run/docker.sock"

// Client talks to one Docker daemon over its unix socket. It is safe for
// concurrent use.
type Client struct {
	socket string
	http   *http.Client
}

// New returns a client for the daemon at socket. An empty socket means
// $DOCKER_HOST when it is a unix:// address, else DefaultSocket.
func New(socket string) *Client {
	if socket == "" {
		socket = DefaultSocket
		if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
			socket = strings.TrimPrefix(h, "unix://")
		}
	}
	c := &Client{socket: socket}
	c.http = &http.Client{Transport: &http.Transport{
		DialContext:         func(ctx context.Context, _, _ string) (net.Conn, error) { return c.dial(ctx) },
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	}}
	return c
}

// Socket is the unix socket path the client dials.
func (c *Client) Socket() string { return c.socket }

func (c *Client) dial(ctx context.Context) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", c.socket)
}

// Error is a non-2xx answer from the daemon.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("docker: %d %s", e.Status, e.Message)
}

// IsNotFound reports whether err is a 404 from the daemon.
func IsNotFound(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// IsConflict reports whether err is a 409 from the daemon (for example an
// exec on a stopped container).
func IsConflict(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusConflict
}

func newRequest(ctx context.Context, method, path string, query url.Values, body any) (*http.Request, error) {
	u := "http://docker" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encoding docker request: %w", err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// do sends a request and returns the response when it is 2xx. The caller
// closes the body.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any) (*http.Response, error) {
	req, err := newRequest(ctx, method, path, query, body)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker %s %s: %w", method, path, err)
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		return nil, readError(resp)
	}
	return resp, nil
}

func readError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var msg struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &msg) != nil || msg.Message == "" {
		msg.Message = strings.TrimSpace(string(b))
	}
	return &Error{Status: resp.StatusCode, Message: msg.Message}
}

// getJSON decodes a JSON answer into out.
func (c *Client) getJSON(ctx context.Context, method, path string, query url.Values, body, out any) error {
	resp, err := c.do(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decoding docker %s %s: %w", method, path, err)
	}
	return nil
}

// Ping checks that the daemon answers.
func (c *Client) Ping(ctx context.Context) error {
	return c.getJSON(ctx, http.MethodGet, "/_ping", nil, nil, nil)
}

// Stream is a hijacked connection (attach, exec start): Read gets output,
// Write sends stdin, CloseWrite sends EOF on stdin.
type Stream struct {
	conn net.Conn
	br   *bufio.Reader
}

func (s *Stream) Read(p []byte) (int, error)  { return s.br.Read(p) }
func (s *Stream) Write(p []byte) (int, error) { return s.conn.Write(p) }

// CloseWrite half-closes the connection so the process sees EOF on stdin.
func (s *Stream) CloseWrite() error {
	if cw, ok := s.conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

// SetWriteDeadline bounds a Write to a process that stopped reading stdin.
func (s *Stream) SetWriteDeadline(t time.Time) error { return s.conn.SetWriteDeadline(t) }

// Close drops the connection.
func (s *Stream) Close() error { return s.conn.Close() }

// hijack sends a request that upgrades to a raw stream. ctx only bounds the
// handshake: the stream lives until Close.
func (c *Client) hijack(ctx context.Context, method, path string, query url.Values, body any) (*Stream, error) {
	conn, err := c.dial(ctx)
	if err != nil {
		return nil, fmt.Errorf("docker %s %s: %w", method, path, err)
	}
	req, err := newRequest(ctx, method, path, query, body)
	if err != nil {
		conn.Close()
		return nil, err
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Unix(1, 0)) })
	fail := func(err error) (*Stream, error) {
		stop()
		conn.Close()
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, fmt.Errorf("docker %s %s: %w", method, path, err)
	}
	if err := req.Write(conn); err != nil {
		return fail(err)
	}
	br := bufio.NewReaderSize(conn, 32<<10)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return fail(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		err := readError(resp)
		resp.Body.Close()
		stop()
		conn.Close()
		return nil, err
	}
	if !stop() {
		// ctx ended while the handshake finished; the deadline is poisoned.
		conn.Close()
		return nil, ctx.Err()
	}
	_ = conn.SetDeadline(time.Time{})
	return &Stream{conn: conn, br: br}, nil
}

func labelFilters(labels map[string]string) string {
	f := map[string][]string{}
	for k, v := range labels {
		f["label"] = append(f["label"], k+"="+v)
	}
	b, _ := json.Marshal(f)
	return string(b)
}
