// Package update changes software on a node:
//
//   - UpdateAgent replaces the agent binary from a signed release manifest:
//     verify the minisign signature (brand.MinisignPublicKey), apply the
//     version rules, download the binary and check its size and SHA-256,
//     make sure it runs, swap it in atomically, arm a rollback guard and
//     restart through systemd. The guard is a systemd timer that runs the
//     previous binary (`seylo update-guard`) after the timeout: unless the
//     new agent reconnected and confirmed by then, it puts the old binary
//     back and restarts it. The outcome is a durable UpdateResult event.
//   - UpdatePanel swaps the panel container on the panel node. Two panels
//     must never open one SQLite file, so it stops the old panel, snapshots
//     panel.db and metrics.db, starts the new image, waits for health, and
//     on failure restores the snapshot and starts the old image again. A
//     journal on disk lets a restarted agent finish (or undo) a swap.
//   - UpdateDocker upgrades Docker Engine with the distribution's package
//     manager; Reboot reboots the machine after a short delay.
//   - CheckOnConnect: when auto-update is on and the panel runs a newer
//     release, the node fetches that release's manifest and updates itself.
//
// Rewritten rather than ported from the Wings fork, whose self-update had
// no signature check or rollback.
//
// Release manifest: see manifest.go and CONTRACTS.md "Releases and
// updates". The panel fetches and verifies the manifest too, but the agent
// never trusts the panel's word: it verifies the signature itself.
//
// Interfaces used by other packages:
//
//   - Updater: the UpdateAgent, UpdatePanel, UpdateDocker and Reboot RPC
//     handlers call it (agent/wire_node.go).
//   - PanelRuntime: what the panel swap needs from the runtime; the agent
//     adapts reconcile and the state store to it.
package update
