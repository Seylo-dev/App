# Seylo 0.2.4

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-4

## Changed

- **Telemetry is on by default for a new panel.** The setup page shows **Send anonymous usage reports**, switched on, next to the owner account, and says what is sent: once a day, the version, how many nodes and services, and a random id. The first report goes a day after setup, so turning it off there means none is ever sent. Settings > Telemetry changes it later.
- **`--no-telemetry`** on the installer starts that switch off. `SEYLO_TELEMETRY=off` or `DO_NOT_TRACK=1` in the installer's environment do the same.
- **`SEYLO_TELEMETRY=off` or `DO_NOT_TRACK=1` on the panel's container** turn reports off whatever the setting says; the switch then shows off and locked, and `settings.updateTelemetry` refuses to turn it on (`409`, reason `telemetryOffByEnv`).

## After you update

- Nothing changes on a panel that is already set up: telemetry stays as it was (off, unless you turned it on).
