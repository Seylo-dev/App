// Package cleanup removes Docker resources and data Seylo no longer needs:
// stopped containers (job leftovers, old generations, removed services),
// images past the newest few per service (keeping the ones in use and the
// desired one, so rollback stays instant), Docker volumes and data folders
// of services removed from the node, and project networks with no service
// left. It only ever touches resources with the seylo.managed label
// (docker.IsManaged), checked again right before each removal; a
// whole-machine prune was rejected on purpose, because nodes may run other
// workloads such as Pelican Wings game servers. Every prune can run as a
// dry run first, which reports the same lines with sizes.
//
// PruneRequest flags map to: stopped_containers -> containers and unused
// project networks; images -> images; orphaned_service_data -> Docker
// volumes and services/<id> folders; build_cache -> the builder's own
// cache through CachePruner (never Docker's machine-wide cache).
//
// Interfaces used by other packages:
//
//   - Pruner: the Prune RPC handler and the scheduled cleanup call it.
//     Local is the implementation; Plan holds the selection rules.
package cleanup
