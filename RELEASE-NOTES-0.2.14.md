# Seylo 0.2.14

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-14

## Fixed

- A watch path like `apps/docs/..` was saved and then skipped every push. Patterns start at the repository root and git names changed files without `.` or `..` segments, so such a pattern (`apps/docs/..`, `../shared/**`, `src/./lib`) never matches a file, and every push after it was "Skipped by watch paths". Saving now refuses it with a hint, for example "apps/docs/.. never matches a file: paths start at the repository root. To watch a folder, write apps/docs/**". The Watch paths card shows the same message under the patterns as you type and keeps Save off until it is fixed; `services.setWatchPaths` in the API and MCP refuses it with the entry's field (`watchPaths.<n>`), and an import leaves such watch paths out with a warning. Patterns stay what they were: `*` (not across `/`), `**` (across folders), `?` and `!` to exclude, and a leading `./` is still dropped. Patterns saved before are not changed: if the Source tab shows the message for one, replace it with the pattern it suggests, or its pushes keep being skipped.
