# Seylo 0.2.10

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-10

## Improved

- **Another tag of the version a database runs.** The Version card on a database's Settings tab has Another tag of <engine> <version>, also when the database already runs the newest pinned image of its version and no other choice of it can be picked. Give another exact release tag of the engine's official image, such as a newer patch release Seylo's catalog does not have yet: it is a patch update (no backup needed, not tested by Seylo). An older release and the image that already runs are refused, Postgres keeps its Alpine (pgvector: Debian trixie) base, and KeyDB and Dragonfly still take the catalog's image only. In the API and MCP, `databases.versionChoices` returns `customOnCurrent`.
