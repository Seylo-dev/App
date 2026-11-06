// Package state persists what the agent must not forget across restarts
// and panel outages, under datadir.Layout.StateDir:
//
//   - the last accepted desired state (so services keep running and
//     reconciling while the panel is away),
//   - the actual-state store with its epoch/seq numbering (see state.proto),
//   - the outbox of durable events (crash reports, cron runs, backup and
//     final deploy/build results) waiting for the panel to acknowledge them.
//
// Interfaces used by other packages:
//
//   - DesiredStore: the persisted desired state (FileDesiredStore).
//   - DesiredSync: accepts SyncDesired/ApplyService/RemoveService with the
//     revision rules, saves, then publishes to the feed.
//   - DesiredFeed: reconcile publishes the accepted desired state; settings,
//     cron and tunnel followers subscribe.
//   - Store: reconcile and crash write service status; the agent serves
//     GetStateSnapshot and pushes StateDelta events from it (MemoryStore:
//     in memory by design, a restart starts a new epoch and reconcile
//     rebuilds it from Docker).
//   - Reporter: what components call to queue a durable report
//     (OutboxReporter over an Outbox in the agent; rpctest.Recorder in tests).
//   - Outbox: the on-disk queue the connection loop drains to PanelService
//     (FileOutbox, bounded, oldest dropped first). MemoryOutbox is the
//     in-memory version for tests.
//   - WriteFileAtomic: temp file, fsync, rename, fsync dir.
package state
