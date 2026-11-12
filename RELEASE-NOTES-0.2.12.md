# Seylo 0.2.12

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-12

## Improved

- **A clone keeps Deploy on push.** Cloning an app built from a repository (GitHub, a git URL, GitLab, Gitea or Bitbucket) used to turn Deploy on push off on the clone. It now keeps the source's setting, and the Clone dialog has a "Deploy on push" switch that starts as the source's, with a note that each push to the branch then deploys both services. A clone that deploys on push picks up the next push to its branch: through the GitHub App like the source, and for a repository read through the connected GitHub account or a GitLab, Gitea or Bitbucket connection through a repository webhook of its own, created with the clone (polled every minute while the webhook cannot be created, as for any other service). A git URL deploys on push through a deploy trigger URL, which a clone does not copy: make one on the clone's Source tab. Export and import are unchanged: an imported service still arrives with Deploy on push off unless you turn it on in the import. In the API and MCP: `services.clone` takes `deployOnPush`; left out, the clone keeps the source's setting.
