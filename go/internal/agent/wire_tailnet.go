package agent

import (
	"context"
	"errors"
	"sync"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/rpc"
	"github.com/seylo-dev/app/go/internal/tailnet"
)

// The tailnet area (added in 0.2.1): the host's own tailscaled, read over
// its LocalAPI socket, and the one Tailscale Serve entry that sends
// https://<machine>.<tailnet>.ts.net to the panel's unix socket
// (proto/seylo/agent/v1/tailnet.proto, package go/internal/tailnet).
//
// It registers TailscaleLogin and TailscaleSetDns (tailnet.login.v1),
// advertises tailnet.serve.v1 (the agent follows NodeSettings.tailnet and
// reports NodeFacts.tailscale) and adds the "tailnet" component. config.yml
// no_tailnet: true keeps it all off: the entry is removed, none is added
// and both methods answer PERMISSION_DENIED.

// tailnetServeCapability says the agent reports TailscaleInfo and keeps
// the panel's Serve entry (apps/panel/src/modules/tailscale/ops.ts).
const tailnetServeCapability = "tailnet.serve.v1"

// provideTailnet builds nothing other areas use (phase 1).
func provideTailnet(_ *Deps) error { return nil }

// wireTailnet registers the area's handlers, capability and component
// (phase 2).
func wireTailnet(reg *Registry, d *Deps) error {
	m := tailnet.NewManager(tailnet.Options{
		Client:      tailnet.NewClient(d.Config.TailscaleSocket),
		PanelSocket: tailnet.PanelSocket(d.Layout.Root()),
		Disabled:    d.Config.NoTailnet,
		Desired:     func() tailnet.Desired { return tailnetDesired(d.Feed.Current()) },
		Publish: func(info *agentv1.TailscaleInfo) {
			d.Facts.Update(func(f *agentv1.NodeFacts) { f.Tailscale = info })
		},
		Logger: d.Logger.With("component", "tailnet"),
	})
	// A pass right away when the desired state changes what the panel
	// wants here, not on every deploy.
	var mu sync.Mutex
	last := tailnetDesired(d.Feed.Current())
	d.Feed.Subscribe(func(st *agentv1.DesiredState) {
		now := tailnetDesired(st)
		mu.Lock()
		changed := last != now
		last = now
		mu.Unlock()
		if changed {
			m.Wake()
		}
	})
	d.Components.Add("tailnet", m.Run)

	rpc.HandleUnary(reg, "TailscaleLogin", func(ctx context.Context, _ *agentv1.TailscaleLoginRequest) (*agentv1.TailscaleLoginResponse, error) {
		link, info, err := m.Login(ctx)
		if err != nil {
			return nil, tailnetStatus(err)
		}
		return &agentv1.TailscaleLoginResponse{AuthUrl: link, Info: info}, nil
	})
	rpc.HandleUnary(reg, "TailscaleSetDns", func(ctx context.Context, req *agentv1.TailscaleSetDnsRequest) (*agentv1.TailscaleSetDnsResponse, error) {
		info, err := m.SetDNS(ctx, req.GetAcceptDns())
		if err != nil {
			return nil, tailnetStatus(err)
		}
		return &agentv1.TailscaleSetDnsResponse{Info: info}, nil
	})
	reg.Advertise(tailnetServeCapability)
	return nil
}

// tailnetDesired is what the desired state says about the panel here.
func tailnetDesired(st *agentv1.DesiredState) tailnet.Desired {
	out := tailnet.Desired{Known: st.GetRevision() > 0, Serve: st.GetSettings().GetTailnet().GetPanel()}
	for _, s := range st.GetServices() {
		if s.GetProtected() && s.GetName() == PanelServiceName {
			out.PanelHere = true
		}
	}
	return out
}

// tailnetStatus maps the tailnet refusals to the statuses tailnet.proto
// names. Messages never carry the sign-in link.
func tailnetStatus(err error) error {
	var he *tailnet.HTTPError
	switch {
	case errors.Is(err, tailnet.ErrDisabled):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_PERMISSION_DENIED, err.Error())
	case errors.Is(err, tailnet.ErrNoTailscaled):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, err.Error())
	case errors.Is(err, tailnet.ErrSignInNotNeeded):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, err.Error())
	case errors.Is(err, tailnet.ErrNoSignInLink):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED, err.Error())
	case errors.Is(err, context.Canceled):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_CANCELLED, "the request ended before tailscaled answered")
	case errors.Is(err, context.DeadlineExceeded):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_DEADLINE_EXCEEDED, "the request ran out of time before tailscaled answered")
	case errors.As(err, &he):
		return rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, err.Error())
	}
	return rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, err.Error())
}
