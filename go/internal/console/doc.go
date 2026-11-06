// Package console attaches to the main process of a service container:
// replays recent output, then relays stdin and output both ways (the
// Console tab). It does not start processes; that is package shell.
//
// Written from scratch; the Wings fork's attach code is the reference for
// the Docker side only.
// Stdin only works when the container was created with an open stdin; the
// session's Info says so, and the UI shows a read-only console otherwise.
//
// Subpackage dockerapi is the small Docker Engine API client the observe
// area (logs, metrics, console, shell) shares.
//
// Interfaces used by other packages:
//
//   - Attacher: the Console RPC handler opens sessions with it.
package console
