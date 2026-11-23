# Seylo 0.2.23

Update from Settings > Updates. Only the panel changes; nodes need nothing. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-23

## Fixed

- **Every push built twice.** A service with a repository webhook hears each push twice: from that webhook, and a few seconds later from the GitHub App. The second copy was only matched to a deploy that had not started yet. By the time it arrived, the first deploy was usually building, so a second deploy of the same commit queued behind it, waited for the whole first build, built again and replaced it. A push now deploys once.
  - A push for a commit the service is already building or deploying is skipped. So is one for a commit whose push deploy went live in the last 10 minutes.
  - The skipped delivery shows in the service's webhook deliveries as ignored ("A deploy of this commit is already queued, running or live."), with a link to the deploy it matched.
  - A late copy of an older push no longer takes over a newer push that is waiting to start.
  - Pushing a commit again later, for example after resetting a branch back to it, still deploys.

## After the update

- Nothing to run by hand: no migration, and the nodes stay as they are.
