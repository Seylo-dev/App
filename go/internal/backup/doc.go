// Package backup streams volume archives and database dumps from the node
// straight to S3-compatible storage (AWS S3, Cloudflare R2, MinIO, ...)
// and restores them. The panel schedules backups and records results; the
// bytes never pass through it.
//
//   - Volumes: a .tar.gz of the volume folder (modes, owners, symlinks),
//     optionally with the service suspended for a consistent copy.
//   - Databases: pg_dump/pg_dumpall, mysqldump/mariadb-dump, mongodump and
//     redis-cli/valkey-cli/keydb-cli --rdb run in a helper container from
//     the database's own image on its project network, so tools match the
//     server version. Dragonfly (SAVE RDB) and ClickHouse (BACKUP to a zip)
//     write into their data folder; their helper mounts the service's
//     volumes and streams that file out, then deletes it.
//   - Uploads are multipart and streamed; a failed dump never leaves an
//     object behind. keep_last retention deletes older objects of the same
//     backup after a success. Between the dump and the upload a spool
//     (spool.go) takes what the upload has not taken yet, 16 MiB in memory
//     and, for the dumps whose database drops a client that stops reading
//     (MySQL/MariaDB net_write_timeout, Redis repl-timeout) and volume
//     archives that stop their service, up to 4 GiB in unnamed files in
//     the data dir's backup-spool folder, never below the free space the
//     node's disk check warns at (15% and 10 GiB). So a part that uploads
//     slowly does not stop the dump. Without room the producer waits, as
//     with a pipe; a dump its database dropped then says so.
//   - Restore sessions raise the server's idle timeouts for themselves
//     (MySQL/MariaDB wait_timeout and net timeouts through --init-command,
//     Postgres idle_session_timeout through PGOPTIONS on 14+), since the
//     client waits as long as the download does; so do the dumps of
//     mysqldump 8.4 and later, the only dump tool that takes an init
//     command. A dump or restore that lost its connection says so
//     (failures.go).
//   - Restores download, unpack into a staging folder and swap (volumes,
//     the RDB of Redis, Valkey, KeyDB and Dragonfly) or pipe into
//     pg_restore/psql/mysql/mongorestore, or into a ClickHouse helper that
//     renames the databases the zip holds aside, runs RESTORE and drops the
//     renamed copies only after it succeeded (puts them back when it
//     fails). An RDB restore keeps the append-only files it replaced as one
//     undo and deletes those of earlier restores.
//
// Interfaces used by other packages:
//
//   - Runner: the RunBackup and RestoreBackup RPC handlers call it. Local
//     is the implementation; its Run method is an agent component.
package backup
