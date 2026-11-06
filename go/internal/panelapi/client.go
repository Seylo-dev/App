package panelapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	"github.com/seylo-dev/app/go/internal/version"
)

// Client calls the panel's op API: GET /api/v1/<id> for queries (input as
// query parameters), POST /api/v1/<id> with a JSON body for the rest, and
// `Authorization: Bearer <api key>`.
type Client struct {
	base  *url.URL
	token string
	HTTP  *http.Client
}

// NewClient checks the URL and returns a client.
func NewClient(panelURL, token string) (*Client, error) {
	u, err := ParsePanelURL(panelURL)
	if err != nil {
		return nil, err
	}
	return &Client{base: u, token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}, nil
}

// ParsePanelURL accepts "https://panel.example.com", "panel.example.com"
// (https assumed) or "http://1.2.3.4:3000", and drops any path.
func ParsePanelURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("%q is not a panel URL like https://panel.example.com", raw)
	}
	return &url.URL{Scheme: u.Scheme, Host: u.Host}, nil
}

// BaseURL is the panel's origin.
func (c *Client) BaseURL() string { return c.base.String() }

// APIError is an error answer from the panel: {"error": {code, message}}.
type APIError struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("the panel answered HTTP %d", e.Status)
	}
	return e.Message
}

// IsCode reports whether err is an APIError with code.
func IsCode(err error, code string) bool {
	var api *APIError
	return errors.As(err, &api) && api.Code == code
}

// Query calls a query op. in is a struct or map whose top-level fields
// become query parameters.
func (c *Client) Query(ctx context.Context, op string, in, out any) error {
	params, err := queryParams(in)
	if err != nil {
		return err
	}
	u := c.opURL(op)
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	return c.do(req, out)
}

// Mutate calls a mutation or destructive op with a JSON body.
func (c *Client) Mutate(ctx context.Context, op string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.opURL(op).String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, out)
}

func (c *Client) opURL(op string) *url.URL {
	u := *c.base
	u.Path = "/api/v1/" + op
	return &u
}

func (c *Client) do(req *http.Request, out any) error {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", brand.Slug+"-cli/"+version.Version)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the panel at %s: %w", c.base, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return apiError(res.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("unexpected answer from the panel: %w", err)
	}
	return nil
}

func apiError(status int, body []byte) error {
	var parsed struct {
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	e := &APIError{Status: status}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error.Code != "" {
		e.Code, e.Message, e.Details = parsed.Error.Code, parsed.Error.Message, parsed.Error.Details
	}
	if e.Code == "UNAUTHENTICATED" || status == http.StatusUnauthorized {
		e.Message = strings.TrimSpace(e.Message + " (the API key may be revoked or expired: run `" + brand.Slug + " login` again)")
	}
	return e
}

// queryParams flattens a struct or map into query parameters the way the
// web client does: strings as they are, numbers and booleans as JSON.
func queryParams(in any) (url.Values, error) {
	values := url.Values{}
	if in == nil {
		return values, nil
	}
	data, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, fmt.Errorf("query input must be an object: %w", err)
	}
	for k, raw := range fields {
		var s string
		switch {
		case string(raw) == "null":
			continue
		case json.Unmarshal(raw, &s) == nil:
			values.Set(k, s)
		default:
			values.Set(k, string(raw))
		}
	}
	return values, nil
}
