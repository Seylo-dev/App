# Seylo 0.2.11

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-11

## Improved

- **Every version change the Version card allows ran on the real images.** MySQL 8.0 to 8.4, MariaDB 11.4 to 11.8, Redis 7.4 to 8.2, Valkey 8.1 to 9.0 to 9.1 (and 8.1 straight to 9.1), ClickHouse 26.3 to 26.8 and a PostgreSQL 17 patch update (the pinned 17.6 to 17.11) now run in Seylo's test setup the way a node runs them, on the same data with the same settings, and every one kept the data, like MongoDB 7.0 to 8.0 to 9.0 and MariaDB 10.11 to 11.4 since 0.2.9. Nothing changes in what you can pick. Exposing a MongoDB 9.0 database over TLS ran there too.

## Fixed

- The API and MCP listed a database's deployments from before a version change as ones it could roll back to (`canRollback`), while the rollback itself refuses them (reason `databaseVersion`), since an older version may not read the files a newer one changed. `deployments.list` and `deployments.get` now say `canRollback: false` for a database's deployment of another image than the one it runs.
