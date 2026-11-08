// Package tailnet puts the panel on the owner's tailnet (added in 0.2.1).
// It uses the tailscaled already running on the host, the owner's own,
// signed in to the owner's tailnet, and talks to it only over its LocalAPI
// socket (/var/run/tailscale/tailscaled.sock, config.yml tailscale_socket).
// It is standard library only: no Tailscale module, image or key.
//
// What the agent does with tailscaled, and nothing more:
//
//   - reads its status and prefs, and reports them as NodeFacts.tailscale
//     (TailscaleInfo, only when something changed);
//   - keeps one Serve entry, https://<machine>.<tailnet>.ts.net/ (or http://
//     when the tailnet has no HTTPS certificates) proxied to
//     unix:<data>/panel/tailnet.sock, while NodeSettings.tailnet.panel asks
//     for it (Ensure and Remove in serve.go). Every other entry in the Serve
//     config stays byte for byte, and the agent never writes AllowFunnel;
//   - starts an interactive login and, on a server that was never signed in,
//     sets WantRunning and turns Tailscale DNS off first (login.go);
//   - turns Tailscale DNS (prefs CorpDNS) on or off.
//
// It never runs `tailscale up`, `down` or `logout`, never changes routes,
// exit nodes or the firewall, never reads /var/lib/tailscale and never logs
// the sign-in link.
//
// config.yml no_tailnet: true (`seylo panel tailscale off`) is the local
// kill switch: the Manager removes its entry, adds none, and Login and
// SetDNS answer ErrDisabled.
//
// Interfaces used by other packages:
//
//   - Client: the LocalAPI client. The agent's tailnet area and
//     `seylo panel tailscale status|off` use it.
//   - Manager: the agent's "tailnet" component (Run), and the TailscaleLogin
//     and TailscaleSetDns handlers (Login, SetDNS).
//   - Ensure, Remove and Find: pure edits of tailscaled's Serve config JSON.
//   - PanelSocket and Targets: where the panel's tailnet socket is and the
//     Proxy values that name it.
package tailnet
