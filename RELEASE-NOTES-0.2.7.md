# Seylo 0.2.7

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-7

## New

- **The app and push notifications.** An owner or admin turns them on in Settings > Notifications, from the panel's domain over HTTPS: the switch stays disabled, with the reason, without an active domain or on the panel's IP:port or tailnet address. Then everyone can install the panel as an app on their phone or computer, and pick in Settings > Push notifications which alerts reach which of their devices: crashes, failed deploys and builds, nodes going offline and coming back, uptime checks, backups, updates, approvals and their own security changes. People only get alerts for what they can see in the panel, and mutes silence pushes too. Pushes go through the browser maker's push service (Google, Apple, Mozilla, Microsoft), encrypted for each device so that service cannot read them.

## Fixed

- The port gate on a node could log "cannot reach the service" twice when two connections failed at the same moment. It logs it once.

## After you update

- The app and push notifications are off until an owner or admin turns them on.
