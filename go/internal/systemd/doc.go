// Package systemd controls the agent's own systemd unit for the node CLI:
// `seylo start`, `seylo restart` and `seylo logs` (no service argument)
// must work when the agent is down, so they go to systemd rather than to
// the agent's local API.
//
// Interfaces used by other packages:
//
//   - Units: start, restart, status and logs of a unit. NewUnits shells out
//     to systemctl and journalctl.
package systemd
