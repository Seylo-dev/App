package tailnet

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var (
	// ErrDisabled is the refusal while config.yml sets no_tailnet: true.
	ErrDisabled = fmt.Errorf("this server's config.yml sets no_tailnet: true (`%s panel tailscale on` there undoes it)", brand.Slug)
	// ErrSignInNotNeeded means the server is signed in: a sign-in link
	// would change nothing (or move it to another tailnet).
	ErrSignInNotNeeded = errors.New("no sign-in needed")
	// ErrNoSignInLink means tailscaled gave no link in time.
	ErrNoSignInLink = errors.New("tailscaled gave no sign-in link in time")
)

// Login asks tailscaled for an interactive sign-in link and returns it
// with the info after it. On a server that was never signed in (no login
// profile) it first sets WantRunning and turns Tailscale DNS off; with a
// profile (an expired key) it never touches prefs. It refuses a server
// that is Running, Stopped (`tailscale down`, which only the owner undoes)
// or waiting for approval. The link is a secret: it is never logged.
func (m *Manager) Login(ctx context.Context) (string, *agentv1.TailscaleInfo, error) {
	if m.opts.Disabled {
		return "", nil, ErrDisabled
	}
	c := m.opts.Client
	st, err := c.Status(ctx)
	if err != nil {
		return "", nil, err
	}
	if err := signInNeeded(st.BackendState); err != nil {
		return "", nil, err
	}
	prefs, err := c.Prefs(ctx)
	if err != nil {
		return "", nil, err
	}
	if !prefs.SignedInBefore() {
		on, off := true, false
		if _, err := c.EditPrefs(ctx, PrefsEdit{WantRunning: &on, CorpDNS: &off}); err != nil {
			return "", nil, fmt.Errorf("turning Tailscale DNS off before the first sign-in: %w", err)
		}
	}
	if err := c.LoginInteractive(ctx); err != nil {
		return "", nil, err
	}
	link, err := m.waitForLink(ctx)
	if err != nil {
		return "", nil, err
	}
	m.opts.Logger.Info("tailnet: started a Tailscale sign-in")
	return link, m.Sync(ctx), nil
}

// waitForLink reads the status until it carries the sign-in link.
func (m *Manager) waitForLink(ctx context.Context) (string, error) {
	deadline := time.NewTimer(m.opts.LoginWait)
	defer deadline.Stop()
	tick := time.NewTicker(m.opts.LoginPoll)
	defer tick.Stop()
	for {
		st, err := m.opts.Client.Status(ctx)
		switch {
		case err == nil && st.AuthURL != "":
			return st.AuthURL, nil
		case err == nil && st.BackendState == StateRunning:
			return "", fmt.Errorf("%w: the server signed in to Tailscale without a link", ErrSignInNotNeeded)
		case errors.Is(err, ErrNoTailscaled):
			return "", err
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			return "", fmt.Errorf("%w (%s). Check that this server reaches its Tailscale control server, then try again", ErrNoSignInLink, m.opts.LoginWait)
		case <-tick.C:
		}
	}
}

// signInNeeded refuses the states where the machine is signed in.
func signInNeeded(state string) error {
	switch state {
	case StateRunning:
		return fmt.Errorf("%w: this server is signed in to Tailscale already", ErrSignInNotNeeded)
	case StateStopped:
		return fmt.Errorf("%w: Tailscale is signed in but stopped on this server (tailscale down). "+
			"Start it there with sudo tailscale up --accept-dns=false", ErrSignInNotNeeded)
	case StateNeedsMachineAuth:
		return fmt.Errorf("%w: this server is signed in and waits for approval in the Tailscale admin console (Machines)", ErrSignInNotNeeded)
	}
	return nil
}

// SetDNS changes only the server's CorpDNS pref (Tailscale DNS) and
// returns the info after it.
func (m *Manager) SetDNS(ctx context.Context, accept bool) (*agentv1.TailscaleInfo, error) {
	if m.opts.Disabled {
		return nil, ErrDisabled
	}
	if _, err := m.opts.Client.EditPrefs(ctx, PrefsEdit{CorpDNS: &accept}); err != nil {
		return nil, err
	}
	m.opts.Logger.Info("tailnet: changed Tailscale DNS", "accept_dns", accept)
	return m.Sync(ctx), nil
}
