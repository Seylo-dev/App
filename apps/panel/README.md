# @seylo/panel

The panel server: Bun + Elysia. It serves the op API, the agent hub, the
live socket for the web app, runs the job queue, owns SQLite, and serves the
built web app.

## Run it

```sh
export SEYLO_DATA_DIR=$HOME/.seylo-dev SEYLO_SECURE_COOKIES=false
bun run create-owner you@example.com                     # once; asks for the password
bun run dev                                               # http://localhost:3000
```

Configuration is environment variables prefixed with the brand slug
(`src/config.ts`): `SEYLO_DATA_DIR` (default `/var/lib/seylo/panel`),
`SEYLO_PORT` (3000), `SEYLO_HOST`, `SEYLO_WEB_DIST`, `SEYLO_VERSION`,
`SEYLO_LOG_LEVEL`, `SEYLO_TRUSTED_PROXIES`, `SEYLO_TRUST_PROXY`, `SEYLO_SECURE_COOKIES`.

Forwarded headers (`X-Forwarded-For/-Proto/-Host`) are believed only from
the proxies in `SEYLO_TRUSTED_PROXIES` (container names resolved on the
panel's Docker network, or addresses; default `seylo-traefik`), so the
directly published IP:port cannot fake a client address.
`SEYLO_TRUST_PROXY=true` trusts every peer and is for development only.
Cookies are always Secure on HTTPS requests; `SEYLO_SECURE_COOKIES=true`
forces it on plain HTTP too.

The data dir holds `panel.db`, `metrics.db` and `master.key`. The key seals
secrets in the database; losing it makes them unreadable, so back it up
with the database.

## Layout

```
src/main.ts            entry: config, data dir, listen, shutdown
src/panel.ts           composes everything (tests use it with in-memory SQLite)
src/modules/<name>/    one feature each: ops (and jobs); index.gen.ts lists them
src/ops/               the op pipeline: authn -> validate -> permission -> rate limit -> run -> audit
src/auth/              principals, sessions, API keys, access checks
src/db/                Drizzle schema (panel.db) and metrics schema (metrics.db)
src/security/          master key, secret box, tokens, passwords, edge ticket key
src/agent-hub/         the agent WebSocket: handshake, session, hub
src/live/              the web app's live WebSocket
src/jobs/              the persisted job queue
src/http/              HTTP adapters: ops, health, static SPA, origin and IP helpers
drizzle/               SQL migrations (generated, committed)
```

## Adding a feature

1. Contracts in `packages/ops/src/ops/<name>.ts` (see its README).
2. `src/modules/<name>/index.ts` default-exporting `defineModule({ name, ops, jobs })`,
   one file per op handler next to it.
3. `make gen` at the repository root regenerates `src/modules/index.gen.ts`.
4. Schema change: edit `src/db/schema/*.ts`, then `bun run db:generate` and
   commit the new migration.
5. Tests with `bun test` against `testPanel()` from `test/helpers.ts`.
