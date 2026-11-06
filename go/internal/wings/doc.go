// Package wings detects Pelican Wings on the node and adapts to it, so
// Seylo runs next to game servers without a VM:
//
//   - FileDetector reads /etc/pelican (or /etc/pterodactyl) config.yml and
//     the Wings fork's proxy folder, and asks the local Wings API for its
//     version and whether it leaves foreign (seylo-*) route files alone;
//   - when the fork runs its Traefik, route files go into its dynamic
//     folder instead of starting our own Traefik on 80/443, and Attacher
//     re-attaches our edge network to that Traefik whenever Wings
//     recreates it;
//   - "game servers first": SliceCPU lowers seylo.slice's CPU weight
//     (weights only, never a hard cap).
//
// Interfaces used by other packages:
//
//   - Detector: the agent reports WingsInfo in NodeFacts; proxy picks its
//     mode from Find.
//   - CPUPriority: follows NodeSettings.games_first_cpu.
package wings
