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
//     container for the database shell on the Connection tab.
//   - TLS for the exposed port: connections through it use the
//     database's own user. ExposedTLS installs the edge's ACME certificate
//     for tls_hostname (or a self-signed one) and turns TLS on inside
//     exposed Postgres and MySQL; MariaDB has its own certificate from
//     11.4 (10.11 has none and is never exposed), and the portgate
//     terminates TLS for the other engines and refuses plain clients of
//     these three. It also retires the separate exposed user of databases
//     created before 0.2.9 (DatabaseSpec.retired_exposed_user), once per
//     node, disabling it without deleting anything; the panel sends it
//     once no running service still has that user's URL.
//
// Interfaces used by other packages:
//
//   - Manager: the edge wakes a UI and touches it on every request.
//     UIs is the implementation.
//   - ClientCommand: the Shell RPC handler for database_client.
package dbtools
