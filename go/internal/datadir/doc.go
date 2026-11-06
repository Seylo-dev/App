// Package datadir is the on-disk layout of a node. Everything Seylo keeps
// on a node lives under one root (brand.DataDir, /var/lib/seylo), so one
// folder exports and imports all of it. Other packages ask this package for
// paths instead of joining strings, so the layout is defined once:
//
//	config.yml                     node config (panel URL, node id, pin)
//	agent.key                      Ed25519 private key of the agent
//	run/agent.sock                 local API for the node CLI
//	state/desired.pb               last accepted desired state (0600)
//	state/outbox/                  durable reports waiting for the panel
//	panel/panel.db                 panel SQLite (only on the panel node)
//	services/<id>/volumes/<name>   service volumes
//	services/<id>/files            file mounts
//	builds/                        build workspaces and uploaded contexts
//	tools/                         pinned helper binaries (Railpack, Nixpacks)
//	registry/                      image registry storage (panel node)
//	logs/<service id>/             service logs, kept across deploys
//	traefik/                       Traefik config and route files
package datadir
