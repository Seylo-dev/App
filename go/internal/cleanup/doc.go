// Package cleanup removes Docker resources and data Seylo no longer needs:
// stopped containers (job leftovers, old generations, removed services),
// images past the newest few per service (keeping the ones in use and the
// desired one, so rollback stays instant), Docker volumes and data folders
// of services removed from the node, and project networks with no service
// left. It only ever touches resources with the seylo.managed label
// (docker.IsManaged), checked again right before each removal, with one
// exception: images pulled from a registry cannot carry the label, so the
// ones a service's containers were made from (UsedImages) and the panel's
// own image follow the same image rule, and any container on the machine
// keeps them. A whole-machine prune was rejected on purpose, because nodes
// may run other workloads such as Pelican Wings game servers. Every prune
// can run as a dry run first, which reports the same lines with sizes.
//
// PruneRequest flags map to: stopped_containers -> containers and unused
// project networks; images -> images, and on the panel's node a garbage
// collection of its registry through RegistryPruner (what images the panel
// deleted from it leave behind); orphaned_service_data -> Docker volumes
// and services/<id> folders; build_cache -> the builder's own cache
// through CachePruner (never Docker's machine-wide cache).
//
// Scheduled cleanup (NodeSettings.cleanup) runs on the node by itself, so
// it keeps going while the panel is down: on a cron expression in the
// node's time zone and when a disk passes a line (the agent's disk checks
// every 10 minutes hand over the fullest disk's use; at most once an hour,
// every 6 hours while it stays above). Each run is a durable CleanupRun.
//
// Interfaces used by other packages:
//
//   - Pruner: the Prune RPC handler and the scheduled cleanup call it.
//     Local is the implementation; Plan holds the selection rules.
//   - Scheduler: the agent syncs it from the desired-state feed, runs its
//     loop and feeds it disk readings. LocalScheduler is the
//     implementation.
package cleanup
