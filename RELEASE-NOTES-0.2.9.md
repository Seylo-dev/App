# Seylo 0.2.9

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-9

## Improved

- **Exposed databases use their own user and password.** Exposing a database only opens a port to it, with TLS: you sign in with the same user and password as inside, for every engine. Before, Postgres, MySQL, MariaDB, Mongo and ClickHouse got a second login (`external`) with a password of its own. The exposed card on the Connection tab shows the same user and password, `${{<service>.EXPOSED_URL}}` carries them, and there is one Reset password for the database, which counts every service using its credentials, through the exposed port too. The port stays TLS only: Postgres, MySQL and MariaDB clients that do not ask for TLS are refused by the node with the database's own kind of error ("this port only accepts TLS connections: connect with sslmode=require", or MySQL's error 3159), and Mongo, ClickHouse, Redis, Valkey, KeyDB and Dragonfly keep TLS from the node as before. Clients that used `external` need the database's user and password now (Copy on the exposed card).
- **The old exposed user is retired.** In databases created before 0.2.9 the node disables `external` once, without deleting anything it owns: Postgres takes its LOGIN away, MySQL and MariaDB lock it, Mongo and ClickHouse drop the user (their data belongs to the database, not the user). If you made a user named `external` yourself in such a database, it is disabled too: in Postgres `ALTER ROLE external LOGIN` brings it back, in MySQL or MariaDB `ALTER USER 'external'@'%' ACCOUNT UNLOCK`.
- **The new password after a reset stays on screen.** Reset password showed the new password for no time at all: the confirm dialog closed it along with itself. It stays now, with the count of services that need a restart.

## After you update

- Update the nodes too. Exposed Postgres, MySQL and MariaDB databases need the node's agent from 0.2.9: until the node is updated their port stays closed, and Exposed cannot be turned on there ("Update the node first"). Mongo, ClickHouse and the Redis-like engines stay exposed on older nodes.
