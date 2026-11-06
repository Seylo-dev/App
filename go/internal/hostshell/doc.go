// Package hostshell starts root login shells on the node itself (the
// HostShell RPC): a PTY from /dev/ptmx, the login shell of the agent's own
// user (root on a node) from /etc/passwd, started as a login shell ("-bash")
// in a new session with a clean environment, so nothing of the agent's
// environment leaks into it.
//
// The Manager is the gate: it refuses every shell unless Allowed says yes
// (the agent checks NodeSettings.host_shell, which only the panel owner
// turns on, and config.yml's no_host_shell, which the panel cannot
// change), allows at most Max at a time (2), hangs up after Idle without
// input or output (15 minutes), and closes every open shell when the
// setting turns off. Closing a shell hangs up its process group (SIGHUP,
// then SIGKILL after a grace period); processes that started their own
// session, like nohup'd jobs over SSH, keep running.
//
// Linux only: elsewhere Open answers ErrUnsupported.
//
// Interfaces used by other packages:
//
//   - Manager: the agent's HostShell handler opens sessions with it and
//     closes them all when NodeSettings.host_shell turns off.
package hostshell
