# Seylo 0.2.20

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-20

## Fixed

- **MariaDB dumps died right after many clients disconnected.** MariaDB, up to 11.8, does not clear OpenSSL's per-thread error queue before a TLS read or write. Under `thread_handling=pool-of-threads` a worker thread keeps the errors of TLS connections that ended there, and after many clients disconnect at once (game servers restarting together) the next TLS connection such a thread serves that waits on its socket is dropped. A dump that ran right after such a restart failed with "Error 2026: TLS/SSL error: unexpected eof while reading when dumping table ...", and the server logged "Got an error writing communication packets". MySQL and MariaDB dumps, restores and the listing of what a backup holds now connect without TLS (`skip-ssl`, or `ssl-mode=DISABLED` for MySQL clients) when the server takes a plain connection: the helper runs on the database's own node, on its project network. A server that refuses plain connections (`require_secure_transport`, an admin user that requires SSL) still gets TLS. Needs the node's agent 0.2.20.

## Improved

- **A database backup that loses its connection runs once more.** When the database closed a dump's connection (any of the lines the "The database closed the connection" hint knows) and the dump had not just waited for the upload, the backup runs again a minute later. A second try that works succeeds with a warning that quotes the first try's error; a second failure ends with "This was a second try: ...". Dumps the database dropped while they waited for the upload are not retried (they would wait again), and restores never are. Needs the node's agent 0.2.20.
- **The 2026 hint names the MariaDB thread pool.** A MySQL or MariaDB dump that still ends with a TLS "unexpected eof" (a server that requires TLS) adds that MariaDB with `thread_handling=pool-of-threads` also drops connections right after many clients left at once.
- **The panel's image names itself.** Registries showed the panel image as Bun, its base image; it now carries its own OCI title, description, url and documentation labels.

## After the update

- Nothing to run by hand: no migration. Both backup changes need the node's agent 0.2.20.
- Your own TLS clients of a MariaDB server with `thread_handling=pool-of-threads` can lose connections the same way after a mass disconnect; MariaDB's default, `one-thread-per-connection`, does not.
