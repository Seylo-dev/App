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
//   - Uploads are multipart and streamed (no temp files); a failed dump
//     never leaves an object behind. keep_last retention deletes older
//     objects of the same backup after a success.
//   - Restores download, unpack into a staging folder and swap (volumes,
//     the RDB of Redis, Valkey, KeyDB and Dragonfly) or pipe into
//     pg_restore/psql/mysql/mongorestore, or into a ClickHouse helper that
//     drops the databases the zip holds and runs RESTORE.
//
// Interfaces used by other packages:
//
//   - Runner: the RunBackup and RestoreBackup RPC handlers call it. Local
//     is the implementation; its Run method is an agent component.
package backup
