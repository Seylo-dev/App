# Seylo 0.2.21

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-21

## Improved

- **A database's command on its Advanced tab.** A database's Advanced tab has a **Command** card: what its container runs, for server options such as a connection limit (`mariadbd --max-connections=500`), with an example for its engine. Empty runs the image's own command. **Save and restart** saves it and restarts the database after a confirm, offline for a few seconds; a database deploys in recreate mode, so a command it does not start with fails the deploy and it starts again as it was. Before, a database's command could only be set through the API (`services.update`), and the panel never showed it.

## Fixed

- **A Redis, Valkey or KeyDB command could drop the password.** These engines take their password on the command line, which Seylo's command reads from `$REDIS_PASSWORD` (`$VALKEY_PASSWORD`, `$KEYDB_PASSWORD`). `services.update` now refuses a command for them that does not name that variable, the image's own (empty) command included: the database would have taken connections without a password, and a new password would not have applied.

## After the update

- Nothing to run by hand: no migration, panel only.
