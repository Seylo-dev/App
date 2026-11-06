// Package docker is the agent's only door to the Docker Engine. It owns
// the naming and labeling contract for everything Seylo creates, so that
// cleanup, adoption after an agent restart and coexistence with Pelican
// Wings all rely on one definition.
//
// Rules every caller relies on:
//
//   - Every container, network, volume and image Seylo creates carries the
//     seylo.managed=true label plus the identifying labels in labels.go.
//     Cleanup and pruning only ever touch resources with that label.
//     ListContainers, ListNetworks and ListVolumes only return those.
//   - Every container gets traefik.enable=false: Wings' Traefik runs the
//     Docker provider, and images must not be able to claim host names
//     through their own labels. Routes come only from our route files.
//   - Every container runs under the seylo.slice cgroup parent (a slice
//     with the systemd driver, /seylo.slice with cgroupfs), so "game
//     servers first" is one CPUWeight change on that slice.
//   - The Docker restart policy is always "no"; package crash restarts.
//   - Service instances (reconcile's) have seylo.service and no seylo.role.
//     Containers other components run (Traefik, registry, cron runs, DB web
//     UIs, cloudflared, builds) use RoleLabels and are never touched by
//     reconcile.
//   - Service volumes are named volumes (VolumeName) backed by a bind of
//     <datadir>/services/<owner>/volumes/<name>.
//
// Interfaces used by other packages:
//
//   - Engine: containers, images, networks, volumes, events, exec,
//     attach, logs and stats. Moby is the implementation over the
//     official client (github.com/moby/moby/client); tests use fakes.
//   - names.go and labels.go: names and labels, pure functions.
package docker
