// Package dockerapi is a small Docker Engine API client for the observe
// area (logs, metrics, console, shell, exec). It speaks plain HTTP over the
// Docker unix socket and covers only what those packages need: listing and
// inspecting managed containers, log and stats reads, events, attach and
// exec with hijacked streams.
//
// Lifecycle operations (create, start, stop, remove, networks, pulls) stay
// in package docker, which owns the "only our resources" rule; the create
// and remove calls here exist for integration tests and always add the
// managed label.
//
// Unversioned API paths are used on purpose: the daemon serves its own
// current version, and every field read here has been stable since API 1.41.
package dockerapi
