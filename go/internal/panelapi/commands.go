package panelapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// LoginOptions controls Login.
type LoginOptions struct {
	PanelURL string
	// Token is a scoped API key.
	Token string
	// Profile names the saved credentials, default "default".
	Profile string
}

// Login verifies the API key against the panel and saves it as profile.
// It returns who the key acts as.
func Login(ctx context.Context, opts LoginOptions) (Viewer, error) {
	if strings.TrimSpace(opts.Token) == "" {
		return Viewer{}, errors.New("an API key is required")
	}
	c, err := NewClient(opts.PanelURL, strings.TrimSpace(opts.Token))
	if err != nil {
		return Viewer{}, err
	}
	viewer, err := c.Whoami(ctx)
	if err != nil {
		return Viewer{}, fmt.Errorf("signing in to %s: %w", c.BaseURL(), err)
	}
	path, err := ConfigPath()
	if err != nil {
		return viewer, err
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return viewer, err
	}
	name := opts.Profile
	if name == "" {
		name = DefaultProfile
	}
	cfg.Profiles[name] = Profile{PanelURL: c.BaseURL(), Token: strings.TrimSpace(opts.Token), Email: viewer.Email, SavedAt: time.Now().UTC()}
	cfg.Current = name
	return viewer, cfg.Save(path)
}

// Logout forgets a saved profile.
func Logout(profile string) error {
	path, err := ConfigPath()
	if err != nil {
		return err
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return err
	}
	name, _, ok := cfg.Profile(profile)
	if !ok {
		return ErrNotLoggedIn
	}
	delete(cfg.Profiles, name)
	if cfg.Current == name {
		cfg.Current = ""
	}
	return cfg.Save(path)
}

// DeployOptions controls Deploy.
type DeployOptions struct {
	Service ServiceRef
	// Wait follows the deploy until it succeeds or fails.
	Wait bool
	// Poll is the log polling interval; default 1s.
	Poll time.Duration
}

// ErrDeployFailed: the followed deployment did not go live.
var ErrDeployFailed = errors.New("deploy failed")

// Deploy starts a deploy and, with Wait, prints its log to w until it
// finishes.
func (c *Client) Deploy(ctx context.Context, opts DeployOptions, w io.Writer) error {
	svc, err := c.Resolve(ctx, opts.Service)
	if err != nil {
		return err
	}
	var d Deployment
	if err := c.Mutate(ctx, "deployments.deploy", map[string]string{"serviceId": svc.ID}, &d); err != nil {
		return err
	}
	fmt.Fprintf(w, "Deploying %s (generation %d, deployment %s)\n", svc.Name, d.Generation, d.ID)
	if !opts.Wait {
		return nil
	}
	return c.Follow(ctx, svc.ID, d.ID, opts.Poll, w)
}

// Follow prints a deployment's log until it finishes.
func (c *Client) Follow(ctx context.Context, serviceID, deploymentID string, poll time.Duration, w io.Writer) error {
	if poll <= 0 {
		poll = time.Second
	}
	after := -1
	for {
		var log struct {
			Lines []LogLine `json:"lines"`
			Done  bool      `json:"done"`
		}
		in := map[string]any{"serviceId": serviceID, "deploymentId": deploymentID, "afterSeq": after}
		if err := c.Query(ctx, "deployments.log", in, &log); err != nil {
			return err
		}
		for _, l := range log.Lines {
			prefix := "[" + l.Step + "] "
			if l.Error {
				prefix += "error: "
			}
			fmt.Fprintln(w, prefix+l.Text)
			after = max(after, l.Seq)
		}
		if log.Done {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
	var got struct {
		Deployment Deployment `json:"deployment"`
	}
	if err := c.Query(ctx, "deployments.get", map[string]string{"serviceId": serviceID, "deploymentId": deploymentID}, &got); err != nil {
		return err
	}
	switch got.Deployment.Status {
	case "live":
		fmt.Fprintln(w, "Live.")
		return nil
	case "superseded":
		fmt.Fprintln(w, "Superseded by a newer deploy.")
		return nil
	}
	msg := got.Deployment.Status
	if got.Deployment.Error != "" {
		msg += ": " + got.Deployment.Error
	}
	return fmt.Errorf("%w: %s", ErrDeployFailed, msg)
}

// LogsOptions controls ServiceLogs.
type LogsOptions struct {
	Tail   int
	Follow bool
}

// ServiceLogs prints a service's recent log lines and, with Follow, keeps
// streaming new ones over the logs WebSocket.
func (c *Client) ServiceLogs(ctx context.Context, ref ServiceRef, opts LogsOptions, w io.Writer) error {
	svc, err := c.Resolve(ctx, ref)
	if err != nil {
		return err
	}
	if opts.Tail <= 0 {
		opts.Tail = 200
	}
	if !opts.Follow {
		var out struct {
			Entries []LogEntry `json:"entries"`
			Offline []string   `json:"offlineNodeIds"`
		}
		if err := c.Query(ctx, "logs.search", map[string]any{"serviceId": svc.ID, "limit": opts.Tail}, &out); err != nil {
			return err
		}
		// Search returns newest first; print oldest first like `tail`.
		slices.Reverse(out.Entries)
		for _, e := range out.Entries {
			fmt.Fprintln(w, e.Line)
		}
		if len(out.Offline) > 0 {
			fmt.Fprintf(w, "(lines from %d offline node(s) are missing)\n", len(out.Offline))
		}
		return nil
	}
	var ticket StreamTicket
	if err := c.Query(ctx, "logs.follow", map[string]any{"serviceId": svc.ID, "tail": opts.Tail}, &ticket); err != nil {
		return err
	}
	return c.streamLogs(ctx, ticket, w)
}

// socketURL turns a ticket path into a ws:// or wss:// URL on the panel.
func (c *Client) socketURL(path string) (string, error) {
	rel, err := url.Parse(path)
	if err != nil {
		return "", err
	}
	u := c.base.ResolveReference(rel)
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	}
	return u.String(), nil
}

func (c *Client) streamLogs(ctx context.Context, ticket StreamTicket, w io.Writer) error {
	u, err := c.socketURL(ticket.URL)
	if err != nil {
		return err
	}
	conn, _, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		return fmt.Errorf("opening the log stream: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(16 << 20)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return nil
			}
			return fmt.Errorf("log stream: %w", err)
		}
		var msg struct {
			Type    string     `json:"type"`
			Entries []LogEntry `json:"entries"`
			NodeID  string     `json:"nodeId"`
			Online  bool       `json:"online"`
			Reason  string     `json:"reason"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "entries":
			for _, e := range msg.Entries {
				fmt.Fprintln(w, e.Line)
			}
		case "node":
			state := "went offline; its lines pause"
			if msg.Online {
				state = "is back"
			}
			fmt.Fprintf(w, "(node %s %s)\n", msg.NodeID, state)
		case "end":
			fmt.Fprintf(w, "(stream ended: %s)\n", msg.Reason)
			return nil
		}
	}
}

type envDoc struct {
	Text      string  `json:"text"`
	UpdatedAt *string `json:"updatedAt"`
}

func (c *Client) env(ctx context.Context, serviceID string) (envDoc, error) {
	var doc envDoc
	err := c.Query(ctx, "env.get", map[string]string{"serviceId": serviceID}, &doc)
	return doc, err
}

// ListEnv returns a service's environment as the saved .env text.
func (c *Client) ListEnv(ctx context.Context, ref ServiceRef) (string, error) {
	svc, err := c.Resolve(ctx, ref)
	if err != nil {
		return "", err
	}
	doc, err := c.env(ctx, svc.ID)
	return doc.Text, err
}

// EnvResult says what an env change did.
type EnvResult struct {
	Service  Service
	Missing  []string
	Deployed *Deployment
	// Warnings are the panel's diagnostics (for example an internal
	// address of a service on another node).
	Warnings []string
}

// SetEnv sets KEY=VALUE assignments and redeploys unless noDeploy.
func (c *Client) SetEnv(ctx context.Context, ref ServiceRef, assignments []string, noDeploy bool) (EnvResult, error) {
	return c.editEnv(ctx, ref, noDeploy, func(text string) (string, []string, error) {
		out, err := SetVars(text, assignments)
		return out, nil, err
	})
}

// UnsetEnv removes variables and redeploys unless noDeploy.
func (c *Client) UnsetEnv(ctx context.Context, ref ServiceRef, keys []string, noDeploy bool) (EnvResult, error) {
	return c.editEnv(ctx, ref, noDeploy, func(text string) (string, []string, error) {
		out, missing := UnsetVars(text, keys)
		return out, missing, nil
	})
}

func (c *Client) editEnv(ctx context.Context, ref ServiceRef, noDeploy bool, edit func(string) (string, []string, error)) (EnvResult, error) {
	svc, err := c.Resolve(ctx, ref)
	if err != nil {
		return EnvResult{}, err
	}
	res := EnvResult{Service: svc}
	doc, err := c.env(ctx, svc.ID)
	if err != nil {
		return res, err
	}
	text, missing, err := edit(doc.Text)
	if err != nil {
		return res, err
	}
	res.Missing = missing
	if text == doc.Text {
		return res, nil
	}
	var saved struct {
		Diagnostics []struct {
			Severity string `json:"severity"`
			Message  string `json:"message"`
		} `json:"diagnostics"`
	}
	// expectedUpdatedAt makes the panel refuse when someone saved in
	// between, instead of silently overwriting their change.
	in := map[string]any{"serviceId": svc.ID, "text": text, "expectedUpdatedAt": doc.UpdatedAt}
	if err := c.Mutate(ctx, "env.set", in, &saved); err != nil {
		if IsCode(err, "CONFLICT") {
			return res, errors.New("someone else saved this environment just now; run the command again")
		}
		return res, err
	}
	for _, d := range saved.Diagnostics {
		if d.Severity == "error" || d.Severity == "warning" {
			res.Warnings = append(res.Warnings, d.Message)
		}
	}
	if noDeploy {
		return res, nil
	}
	var d Deployment
	if err := c.Mutate(ctx, "deployments.deploy", map[string]string{"serviceId": svc.ID}, &d); err != nil {
		return res, fmt.Errorf("saved, but the deploy did not start: %w", err)
	}
	res.Deployed = &d
	return res, nil
}

// ExposeOptions controls ExposeTimed.
type ExposeOptions struct {
	Service ServiceRef
	Port    uint32
	For     time.Duration
	// FromCIDR defaults to the caller's public IP as seen by the panel.
	FromCIDR string
	// Wait bounds waiting for the agent to report the port; default 30s.
	Wait time.Duration
}

// ExposeTimed opens a service port to one source address for a while and
// returns the open expose (host:port once the agent reported it).
func (c *Client) ExposeTimed(ctx context.Context, opts ExposeOptions) (TimedExpose, error) {
	svc, err := c.Resolve(ctx, opts.Service)
	if err != nil {
		return TimedExpose{}, err
	}
	minutes := int(opts.For.Round(time.Minute) / time.Minute)
	if minutes < 5 || minutes > 1440 {
		return TimedExpose{}, errors.New("--for must be between 5m and 24h")
	}
	in := map[string]any{"serviceId": svc.ID, "targetPort": opts.Port, "durationMinutes": minutes}
	if opts.FromCIDR != "" {
		in["allowedCidrs"] = []string{opts.FromCIDR}
	}
	var exp TimedExpose
	if err := c.Mutate(ctx, "exposures.openTimed", in, &exp); err != nil {
		return exp, err
	}
	wait := opts.Wait
	if wait <= 0 {
		wait = 30 * time.Second
	}
	deadline := time.Now().Add(wait)
	for exp.Port == nil && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return exp, ctx.Err()
		case <-time.After(time.Second):
		}
		var got struct {
			Timed []TimedExpose `json:"timed"`
		}
		if err := c.Query(ctx, "exposures.get", map[string]string{"serviceId": svc.ID}, &got); err != nil {
			return exp, err
		}
		for _, t := range got.Timed {
			if t.ID == exp.ID {
				exp = t
			}
		}
	}
	if exp.Port == nil {
		return exp, errors.New("the node has not opened the port yet; check the service's Access tab")
	}
	return exp, nil
}

// SetCloudflareTunnel turns a service's quick Cloudflare tunnel on or off
// and, when on, waits for its public URL.
func (c *Client) SetCloudflareTunnel(ctx context.Context, ref ServiceRef, enabled bool) (Tunnel, error) {
	svc, err := c.Resolve(ctx, ref)
	if err != nil {
		return Tunnel{}, err
	}
	in := map[string]any{"serviceId": svc.ID, "enabled": enabled}
	var t Tunnel
	if err := c.Mutate(ctx, "tunnels.set", in, &t); err != nil {
		return t, err
	}
	deadline := time.Now().Add(60 * time.Second)
	for enabled && t.URL == nil && t.State != "failed" && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return t, ctx.Err()
		case <-time.After(2 * time.Second):
		}
		if err := c.Query(ctx, "tunnels.get", map[string]string{"serviceId": svc.ID}, &t); err != nil {
			return t, err
		}
	}
	if enabled && t.State == "failed" {
		msg := "the tunnel failed to start"
		if t.Error != nil {
			msg += ": " + *t.Error
		}
		return t, errors.New(msg)
	}
	return t, nil
}
