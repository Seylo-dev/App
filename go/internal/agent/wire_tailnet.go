package agent

// The tailnet area (added in 0.2.1): the host's own tailscaled, read over
// its LocalAPI socket, and the one Tailscale Serve entry that sends
// https://<machine>.<tailnet>.ts.net to the panel's unix socket
// (proto/seylo/agent/v1/tailnet.proto). Package go/internal/tailnet.
//
// Not built yet (WP-F3a). Until it is, this area registers nothing on
// purpose: TailscaleLogin and TailscaleSetDns answer UNIMPLEMENTED (the mux
// does that for unregistered methods), and neither tailnet.login.v1 nor
// tailnet.serve.v1 is advertised, so no panel calls them or sends this
// agent NodeSettings.tailnet expecting it to act. Registering stub handlers
// here instead would advertise tailnet.login.v1 before it works. WP-F3a
// registers, together:
//
//	rpc.HandleUnary(reg, "TailscaleLogin", func(ctx context.Context, req *agentv1.TailscaleLoginRequest) (*agentv1.TailscaleLoginResponse, error)
//	rpc.HandleUnary(reg, "TailscaleSetDns", func(ctx context.Context, req *agentv1.TailscaleSetDnsRequest) (*agentv1.TailscaleSetDnsResponse, error)
//	reg.Advertise("tailnet.serve.v1")
//
// plus the "tailnet" component (d.Components.Add) that fills
// NodeFacts.tailscale through d.Facts.Update.

// provideTailnet builds the area's components (phase 1). Nothing yet.
func provideTailnet(_ *Deps) error { return nil }

// wireTailnet registers the area's handlers, capability and component
// (phase 2). Nothing yet: see the comment at the top of this file.
func wireTailnet(_ *Registry, _ *Deps) error { return nil }
