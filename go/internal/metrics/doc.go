// Package metrics samples node and container usage every 10 seconds, keeps
// the latest sample for GetMetrics, streams live samples for WatchMetrics
// and pushes each sample to the panel as a best-effort event (the panel
// keeps the live window and rolls them up into metrics.db).
//
// Node usage comes from /proc and /sys (CPU, memory, swap, load, physical
// network interfaces, every real filesystem). Container usage comes from
// Docker's one-shot stats, summed per service over its replicas.
//
// Container memory is usage - inactive_file (what `docker stats` reports),
// not raw usage, which counts page cache and looks like a leak.
//
// Ported in part from the Wings fork's environment/docker/stats.go (MIT).
//
// Interfaces used by other packages:
//
//   - Collector: the agent runs it; the metrics RPC handlers read it.
package metrics
