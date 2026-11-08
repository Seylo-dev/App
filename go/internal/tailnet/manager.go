package tailnet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"slices"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// HealthPath is the panel's health endpoint the Manager asks through the
// panel's socket (apps/panel/src/http/health.ts).
const HealthPath = "/api/health"

// Desired is what the node's desired state says about the panel here.
type Desired struct {
	// Known is false until the agent accepted a desired state (revision
	// 0, or a stored one that could not be read): the Manager then leaves
	// the Serve config alone and reports no Serve status.
	Known bool
	// PanelHere: the protected panel service is in this node's desired
	// state.
	PanelHere bool
	// Serve is NodeSettings.tailnet.panel.
	Serve bool
}

// Options configures a Manager.
type Options struct {
	Client *Client
	// PanelSocket is the host path of the panel's tailnet socket
	// (PanelSocket).
	PanelSocket string
	// Disabled is config.yml's no_tailnet.
	Disabled bool
	// Desired reads the node's desired state.
	Desired func() Desired
	// Publish receives TailscaleInfo when it changed (nil: no tailscaled),
	// and at least every FactsRefresh while it stays the same.
	Publish func(*agentv1.TailscaleInfo)
	Logger  *slog.Logger
	Now     func() time.Time
	// Interval between passes. Default 30 s.
	Interval time.Duration
	// ProbeInterval between requests to HealthPath through the panel's
	// socket. Default 60 s.
	ProbeInterval time.Duration
	// FactsRefresh publishes unchanged info again so checked_at moves.
	// Default 5 minutes.
	FactsRefresh time.Duration
	// LoginWait is how long Login waits for the sign-in link. Default 15 s.
	LoginWait time.Duration
	// LoginPoll is how often Login reads the status meanwhile. Default 250 ms.
	LoginPoll time.Duration
	// Probe replaces the request through the panel's socket (tests).
	Probe func(ctx context.Context, socket, dnsName string, https bool) bool
}

// Manager is the agent's "tailnet" component: every Interval (and on
// Wake) it reads tailscaled, keeps or removes the panel's Serve entry and
// publishes TailscaleInfo. One pass runs at a time.
type Manager struct {
	opts Options
	wake chan struct{}

	mu sync.Mutex // one pass at a time; guards the fields below
	// sent is the info last published, sentAt when.
	sent   *agentv1.TailscaleInfo
	sentAt time.Time
	// The last probe through the panel's socket, and what it was for.
	probedAt  time.Time
	probedFor string
	answers   bool
	// logged is the state last logged, so each change is logged once.
	logged string
}

// NewManager fills the defaults of opts.
func NewManager(opts Options) *Manager {
	if opts.Client == nil {
		opts.Client = NewClient("")
	}
	if opts.Desired == nil {
		opts.Desired = func() Desired { return Desired{} }
	}
	if opts.Publish == nil {
		opts.Publish = func(*agentv1.TailscaleInfo) {}
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Interval <= 0 {
		opts.Interval = 30 * time.Second
	}
	if opts.ProbeInterval <= 0 {
		opts.ProbeInterval = time.Minute
	}
	if opts.FactsRefresh <= 0 {
		opts.FactsRefresh = 5 * time.Minute
	}
	if opts.LoginWait <= 0 {
		opts.LoginWait = 15 * time.Second
	}
	if opts.LoginPoll <= 0 {
		opts.LoginPoll = 250 * time.Millisecond
	}
	if opts.Probe == nil {
		opts.Probe = probePanel
	}
	return &Manager{opts: opts, wake: make(chan struct{}, 1)}
}

// Run passes every Interval and on Wake until ctx ends.
func (m *Manager) Run(ctx context.Context) error {
	t := time.NewTicker(m.opts.Interval)
	defer t.Stop()
	for {
		m.Sync(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-m.wake:
		}
	}
}

// Wake asks for a pass now (the desired state changed).
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Disabled reports config.yml's no_tailnet.
func (m *Manager) Disabled() bool { return m.opts.Disabled }

// Sync runs one pass and returns the info it found (nil without
// tailscaled). It publishes the info when it changed.
func (m *Manager) Sync(ctx context.Context) *agentv1.TailscaleInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	info := m.pass(ctx)
	m.publish(info)
	m.logState(info)
	return clone(info)
}

func (m *Manager) pass(ctx context.Context) *agentv1.TailscaleInfo {
	now := m.opts.Now()
	want := m.opts.Desired()
	st, err := m.opts.Client.Status(ctx)
	if errors.Is(err, ErrNoTailscaled) {
		m.answers, m.probedFor = false, ""
		return nil
	}
	if err != nil {
		return m.unreadable(want, now, "Reading Tailscale's status failed: "+err.Error())
	}
	prefs, err := m.opts.Client.Prefs(ctx)
	if err != nil {
		return m.unreadable(want, now, "Reading Tailscale's settings failed: "+err.Error())
	}
	info := Info(st, prefs)
	info.DisabledOnServer = m.opts.Disabled
	info.Serve = m.serve(ctx, info, want, now)
	return info
}

// unreadable is the last info with the error as the Serve state, for a
// tailscaled that answers but not as expected.
func (m *Manager) unreadable(want Desired, now time.Time, msg string) *agentv1.TailscaleInfo {
	info := clone(m.sent)
	if info == nil {
		info = &agentv1.TailscaleInfo{}
	}
	info.DisabledOnServer = m.opts.Disabled
	info.Serve = nil
	if want.Known && want.PanelHere {
		info.Serve = &agentv1.TailnetServeStatus{
			State: agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR, Message: msg, CheckedAt: timestamppb.New(now),
		}
	} else {
		m.opts.Logger.Warn("reading tailscaled failed", "err", msg)
	}
	return info
}

// serve keeps or removes the panel's entry and reports where it stands.
// It is nil on nodes without the panel.
func (m *Manager) serve(ctx context.Context, info *agentv1.TailscaleInfo, want Desired, now time.Time) *agentv1.TailnetServeStatus {
	if !want.Known {
		return nil
	}
	target, ours := Targets(m.opts.PanelSocket)
	st := &agentv1.TailnetServeStatus{CheckedAt: timestamppb.New(now)}
	raw, etag, err := m.opts.Client.GetServeConfig(ctx)
	if err != nil {
		if !want.PanelHere {
			m.opts.Logger.Warn("reading the Tailscale Serve config failed", "err", err)
			return nil
		}
		st.State, st.Message = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR, "Reading the Tailscale Serve config failed: "+err.Error()
		return st
	}
	w := Want{DNSName: info.GetDnsName(), HTTPS: info.GetHttps(), Target: target, Aliases: ours[1:]}
	var ch Change
	switch {
	case !want.PanelHere || !want.Serve || m.opts.Disabled:
		st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF
		ch, err = Remove(raw, ours...)
	case !VersionOK(info.GetVersion()):
		st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_UNSUPPORTED
		st.Message = fmt.Sprintf("Tailscale %s on this server is older than %s, the first release %s serves the panel through. "+
			"Update it: curl -fsSL https://tailscale.com/install.sh | sh", orUnknown(info.GetVersion()), MinVersion, brand.DisplayName)
		ch, err = Remove(raw, ours...)
	case info.GetBackendState() != StateRunning || !info.GetMagicDns() || w.DNSName == "":
		// Signed out, stopped, waiting for approval or without MagicDNS:
		// the entry, if any, stays for when it comes back.
		st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_OFF
	case !socketExists(m.opts.PanelSocket):
		// The panel is not listening (it is restarting): keep an entry
		// that is there, add none yet.
		st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_APPLYING
		if found, _ := Find(raw, target); slices.Contains(found, ServeEntry{HostPort: w.HostPort(), Path: "/", Proxy: target}) {
			st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE
		}
	default:
		ch, err = Ensure(raw, w)
		st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE
		if ch.Conflict != "" {
			st.State, st.Message = agentv1.TailnetServeState_TAILNET_SERVE_STATE_CONFLICT, ch.Conflict
		}
	}
	if err != nil {
		st.State, st.Message = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR, err.Error()
		ch = Change{}
	}
	after := raw
	if ch.Config != nil {
		switch err := m.opts.Client.SetServeConfig(ctx, ch.Config, etag); {
		case err == nil:
			after = ch.Config
		case errors.Is(err, ErrETagMismatch):
			// Someone changed it after we read it: the next pass reads
			// it again.
			if st.State == agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE {
				st.State = agentv1.TailnetServeState_TAILNET_SERVE_STATE_APPLYING
			}
		default:
			st.State, st.Message = agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR, "Writing the Tailscale Serve config failed: "+err.Error()
		}
	}
	if found, err := Find(after, ours...); err == nil && len(found) > 0 {
		st.Proxy = found[0].Proxy
		for _, e := range found {
			if e.Proxy == target {
				st.Proxy = target
			}
		}
	}
	if st.State == agentv1.TailnetServeState_TAILNET_SERVE_STATE_ACTIVE {
		st.Url = w.URL()
	}
	if !want.PanelHere {
		if st.State == agentv1.TailnetServeState_TAILNET_SERVE_STATE_ERROR {
			m.opts.Logger.Warn("removing the panel's Tailscale Serve entry failed", "err", st.Message)
		}
		return nil
	}
	st.PanelAnswers = m.probe(ctx, info, now)
	return st
}

// probe asks HealthPath through the panel's socket, at most every
// ProbeInterval unless the machine name or scheme changed.
func (m *Manager) probe(ctx context.Context, info *agentv1.TailscaleInfo, now time.Time) bool {
	if info.GetDnsName() == "" || !socketExists(m.opts.PanelSocket) {
		m.answers, m.probedFor = false, ""
		return false
	}
	key := scheme(info.GetHttps()) + "://" + info.GetDnsName()
	if key != m.probedFor || now.Sub(m.probedAt) >= m.opts.ProbeInterval {
		m.answers = m.opts.Probe(ctx, m.opts.PanelSocket, info.GetDnsName(), info.GetHttps())
		m.probedAt, m.probedFor = now, key
	}
	return m.answers
}

// publish sends info when it differs from the last one in more than
// checked_at, or FactsRefresh after the last send.
func (m *Manager) publish(info *agentv1.TailscaleInfo) {
	now := m.opts.Now()
	if info == nil && m.sent == nil {
		return
	}
	if sameInfo(info, m.sent) && now.Sub(m.sentAt) < m.opts.FactsRefresh {
		return
	}
	m.sent, m.sentAt = clone(info), now
	m.opts.Publish(clone(info))
}

func (m *Manager) logState(info *agentv1.TailscaleInfo) {
	state, serve, msg := "none", "", ""
	if info != nil {
		state = info.GetBackendState()
		serve = info.GetServe().GetState().String()
		msg = info.GetServe().GetMessage()
	}
	key := state + "|" + serve + "|" + msg
	if key == m.logged {
		return
	}
	m.logged = key
	attrs := []any{"backend_state", state}
	if serve != "" {
		attrs = append(attrs, "serve_state", serve)
	}
	if msg != "" {
		m.opts.Logger.Warn("tailnet: "+msg, attrs...)
		return
	}
	if info == nil {
		m.opts.Logger.Info("tailnet: no tailscaled", "socket", m.opts.Client.Socket())
		return
	}
	m.opts.Logger.Info("tailnet: state changed", attrs...)
}

// sameInfo compares two infos without the Serve checked_at.
func sameInfo(a, b *agentv1.TailscaleInfo) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	a, b = clone(a), clone(b)
	if a.Serve != nil {
		a.Serve.CheckedAt = nil
	}
	if b.Serve != nil {
		b.Serve.CheckedAt = nil
	}
	return proto.Equal(a, b)
}

func clone(info *agentv1.TailscaleInfo) *agentv1.TailscaleInfo {
	if info == nil {
		return nil
	}
	return proto.Clone(info).(*agentv1.TailscaleInfo)
}

func orUnknown(v string) string {
	if v == "" {
		return "(version unknown)"
	}
	return v
}

func socketExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode()&os.ModeSocket != 0
}

// probePanel is one request to HealthPath through the panel's socket,
// with the headers Serve sends for a unix target: Host localhost, the
// tailnet name in X-Forwarded-Host and the scheme in X-Forwarded-Proto. It
// sends no Tailscale-User-Login: the agent is nobody on the tailnet.
func probePanel(ctx context.Context, socket, dnsName string, https bool) bool {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	var dialer net.Dialer
	c := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", socket)
			},
			DisableKeepAlives: true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost"+HealthPath, nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Forwarded-Host", dnsName)
	req.Header.Set("X-Forwarded-Proto", scheme(https))
	req.Header.Set("User-Agent", brand.Slug+"-agent tailnet check")
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}
