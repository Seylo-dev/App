// Package shell starts processes inside service containers with docker
// exec: interactive shells with a PTY (the Console tab in shell mode), bash or sh by
// default or the database engine's client already logged in for
// SERVICE_KIND_DATABASE (the command comes from package dbtools through
// Options.DatabaseClient), and short one-shot commands (the Exec RPC).
//
// Docker does not end a TTY exec when its client goes away, so every
// process carries a marker in its environment and the Sweeper signals them
// in the container's pid namespace on close, on timeout, and for orphans of
// an earlier agent at start.
//
// Ported in part from the Wings fork's server/shell (MIT).
//
// Interfaces used by other packages:
//
//   - Spawner: the Shell RPC handler starts sessions with it.
//   - Execer: the Exec RPC handler runs commands with it.
package shell
