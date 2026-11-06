// Package dbtools runs the database tools of SERVICE_KIND_DATABASE
// services:
//
//   - Web UIs started on demand and stopped when idle: pgweb (Postgres),
//     phpMyAdmin (MySQL, MariaDB), mongo-express (Mongo), Redis Commander
//     (Redis, Valkey, KeyDB, Dragonfly) and ClickHouse's own Play page
//     behind an nginx that signs it in. Each runs as a helper container on
//     the database's project network, already signed in with
//     DatabaseSpec.credentials, and is reached only through the edge after
//     a panel-signed ticket: it never gets a published port.
//   - Pre-logged-in shells: ClientCommand gives the psql, mysql/mariadb,
//     mongosh, clickhouse-client or redis-cli/valkey-cli/keydb-cli command
//     (and the env carrying the password) to exec inside the database
//     container for the Shell tab.
//   - The exposed user (DatabaseExposure.user/password): ExposedUsers
//     creates it inside the running database, or rotates its password,
//     with the engine's client (Postgres, MySQL, MariaDB, Mongo,
//     ClickHouse; the Redis-like engines have one user), and makes it
//     TLS-only on Postgres, MySQL and MariaDB with the edge's ACME
//     certificate for tls_hostname or a self-signed one.
//
// Interfaces used by other packages:
//
//   - Manager: the edge wakes a UI and touches it on every request.
//     UIs is the implementation.
//   - ClientCommand: the Shell RPC handler for database_client.
package dbtools
