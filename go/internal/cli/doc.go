// Package cli is the cobra command tree of the seylo binary. One binary
// serves three audiences:
//
//   - the node daemon: `seylo agent` (run by systemd; `--join <url>
//     --token <t>` writes config.yml first),
//   - the node CLI, run as root on a node: `seylo join|status|start|
//     restart|logs|health|troubleshoot` and `seylo panel start|status|logs`,
//   - the laptop CLI: `seylo login|logout|deploy|logs <service>|env|tunnel`.
//
// Hidden commands used by the installer and the updater: `seylo panel
// bootstrap` (first panel container + join), `seylo install-units`
// (systemd units from internal/systemd) and `seylo update-guard` (agent
// update rollback, run by a systemd timer).
//
// Commands hold little logic: each parses flags and calls the package that
// owns the feature (agent, localapi, systemd, nodecheck, troubleshoot,
// update, panelapi).
//
// `seylo logs` without a service shows the agent's own journal (node);
// with a service it shows that service's logs through the panel API, which
// works from a laptop and from a node alike.
package cli
