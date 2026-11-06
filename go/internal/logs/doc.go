// Package logs stores service output on the node (logs/<service id>/ in
// the data dir), across deploys, so one history spans every generation. It
// captures container output from Docker (Capturer), keeps Seylo's own
// system lines ("deploy 12 started") and build output (logs/.builds/), trims
// by size and age (the node's LogRetention), and serves follow and search.
// Logs never leave the node except when someone views them.
//
// Files are plain text segments (<seq>.log, one entry per line, see
// format.go) so they stay greppable on the node.
//
// Interfaces used by other packages:
//
//   - Store: reconcile appends system lines, build writes BuildLog, the
//     LogsFollow and LogsSearch handlers read, crash reports use Tail.
package logs
