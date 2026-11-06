package panelapi

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

// BrowserLogin is a started browser-approved sign-in (cliLogin.start).
type BrowserLogin struct {
	UserCode        string    `json:"userCode"`
	DeviceCode      string    `json:"deviceCode"`
	VerificationURL string    `json:"verificationUrl"`
	IntervalSeconds int       `json:"intervalSeconds"`
	ExpiresAt       time.Time `json:"expiresAt"`
}

// ErrLoginDenied: someone denied the sign-in in the browser.
var ErrLoginDenied = errors.New("the sign-in was denied in the browser")

// ErrLoginExpired: nobody approved the sign-in in time.
var ErrLoginExpired = errors.New("the sign-in request expired before anyone approved it: run login again")

// ClientName names this computer for the approval page, like "my-laptop (darwin/arm64)".
func ClientName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "unknown computer"
	}
	if len(host) > 70 {
		host = host[:70]
	}
	return fmt.Sprintf("%s (%s/%s)", host, runtime.GOOS, runtime.GOARCH)
}

// StartBrowserLogin asks the panel for a sign-in request. The returned
// VerificationURL is always absolute.
func StartBrowserLogin(ctx context.Context, panelURL, clientName string) (*Client, BrowserLogin, error) {
	c, err := NewClient(panelURL, "")
	if err != nil {
		return nil, BrowserLogin{}, err
	}
	var start BrowserLogin
	if err := c.Mutate(ctx, "cliLogin.start", map[string]string{"clientName": clientName}, &start); err != nil {
		return nil, BrowserLogin{}, fmt.Errorf("starting the sign-in at %s: %w", c.BaseURL(), err)
	}
	if u, err := url.Parse(start.VerificationURL); err == nil && !u.IsAbs() {
		start.VerificationURL = c.BaseURL() + "/" + strings.TrimPrefix(start.VerificationURL, "/")
	}
	return c, start, nil
}

type pollResult struct {
	Status string `json:"status"`
	Key    *struct {
		Token string `json:"token"`
		Email string `json:"email"`
	} `json:"key"`
	IntervalSeconds int `json:"intervalSeconds"`
}

// WaitBrowserLogin polls until the request is approved (it returns the new
// API key), denied, expired or ctx ends.
func (c *Client) WaitBrowserLogin(ctx context.Context, start BrowserLogin) (string, error) {
	interval := time.Duration(max(start.IntervalSeconds, 1)) * time.Second
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		var res pollResult
		if err := c.Mutate(ctx, "cliLogin.poll", map[string]string{"deviceCode": start.DeviceCode}, &res); err != nil {
			// Rate limits and short outages: keep polling until the request expires.
			if IsCode(err, "RATE_LIMITED") || !isAPIError(err) {
				if !start.ExpiresAt.IsZero() && time.Now().After(start.ExpiresAt) {
					return "", ErrLoginExpired
				}
				continue
			}
			return "", err
		}
		if res.IntervalSeconds > 0 {
			interval = time.Duration(res.IntervalSeconds) * time.Second
		}
		switch res.Status {
		case "pending":
			continue
		case "approved", "used":
			if res.Key == nil || res.Key.Token == "" {
				return "", errors.New("the sign-in was approved, but its key was already handed out: run login again")
			}
			return res.Key.Token, nil
		case "denied":
			return "", ErrLoginDenied
		case "expired":
			return "", ErrLoginExpired
		default:
			return "", fmt.Errorf("unexpected sign-in status %q", res.Status)
		}
	}
}

func isAPIError(err error) bool {
	var api *APIError
	return errors.As(err, &api)
}
