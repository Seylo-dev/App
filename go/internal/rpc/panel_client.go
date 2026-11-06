package rpc

import (
	"context"

	"google.golang.org/protobuf/reflect/protoreflect"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// PanelClient is the typed client for PanelService, the methods the agent
// calls on the panel. Build it over a Link so it works across reconnects.
type PanelClient struct {
	peer Peer
}

// NewPanelClient returns a client calling through peer.
func NewPanelClient(peer Peer) *PanelClient { return &PanelClient{peer: peer} }

// Peer returns the underlying peer.
func (c *PanelClient) Peer() Peer { return c.peer }

func panelMethod(name string) string {
	svc := agentv1.File_seylo_agent_v1_panel_service_proto.Services().ByName("PanelService")
	return MethodName(svc.Methods().ByName(protoreflect.Name(name)))
}

// Full wire names of PanelService methods.
var (
	MethodReportCrash     = panelMethod("ReportCrash")
	MethodReportEvent     = panelMethod("ReportEvent")
	MethodGetDesiredState = panelMethod("GetDesiredState")
	MethodRegistryTunnel  = panelMethod("RegistryTunnel")
)

// ReportCrash delivers one outbox crash report. Components do not call it:
// they queue reports with state.Reporter and the outbox drain calls this.
func (c *PanelClient) ReportCrash(ctx context.Context, req *agentv1.ReportCrashRequest) (*agentv1.ReportCrashResponse, error) {
	resp := &agentv1.ReportCrashResponse{}
	if err := c.peer.Call(ctx, MethodReportCrash, req, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// ReportEvent delivers one outbox event (outbox drain only, as above).
func (c *PanelClient) ReportEvent(ctx context.Context, req *agentv1.ReportEventRequest) (*agentv1.ReportEventResponse, error) {
	resp := &agentv1.ReportEventResponse{}
	if err := c.peer.Call(ctx, MethodReportEvent, req, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// GetDesiredState asks for the desired state when the agent's is older
// than knownRevision's successor. A nil State in the response means the
// agent is current.
func (c *PanelClient) GetDesiredState(ctx context.Context, req *agentv1.GetDesiredStateRequest) (*agentv1.GetDesiredStateResponse, error) {
	resp := &agentv1.GetDesiredStateResponse{}
	if err := c.peer.Call(ctx, MethodGetDesiredState, req, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// RegistryTunnel opens a raw bidi stream to the panel registry. Copy bytes
// with Read/Write, CloseSend when the local side is done, then Finish with
// a *agentv1.RegistryTunnelResponse.
func (c *PanelClient) RegistryTunnel(ctx context.Context, req *agentv1.RegistryTunnelRequest) (Stream, error) {
	return c.peer.Open(ctx, MethodRegistryTunnel, req)
}
