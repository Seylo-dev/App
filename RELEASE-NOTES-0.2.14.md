# Seylo 0.2.14

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-14

## New

## Improved

- **GIT_SHA, the commit a deployment was built from, like Easypanel.** Builds from git (a GitHub repository, a GitLab, Gitea or Bitbucket connection, or a clone URL, with any builder) get `GIT_SHA` with the full 40-character id of the commit the node checked out: a build arg for Dockerfiles (`ARG GIT_SHA`), and a build variable for Railpack and Nixpacks. It is the commit actually built, also for a deploy of the branch head, a redeploy and a short commit id from a deploy URL; the build log shows it (`--> GIT_SHA=...`). A Dockerfile that declares no `ARG GIT_SHA` builds as before. The running containers of that deployment get the same `GIT_SHA` as an environment variable: a restart keeps it, and a rollback runs with the commit of the deployment it rolls back to. Images that read the commit at boot or bake it into the build, as images written for Easypanel do (an app version, or the deployment id Next.js uses against version skew), now get it. A `GIT_SHA` you set yourself, in the service's variables or the project's shared ones, wins, also an empty one. Images, uploaded archives and Dockerfiles typed in the panel get none. Running apps are not restarted for it: each service gets it with its next deploy. The Environment tab's References panel mentions it for services built from a repository. Nodes still on 0.2.13 or older pass no build arg, but their deployments get the environment variable.

## Fixed
