# Seylo 0.2.2

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-2

## New

- **A GitHub tab in New app.** Type `owner/repo` or a GitHub address, or Browse the repositories of your GitHub App installations and the connected account, then pick a branch. A line under the field says whether the app deploys on push or is cloned as a public repository. With nothing on GitHub connected, the tab shows owners and admins the three steps to connect it. Docs: https://docs.seylo.dev/guides/github-and-git#in-the-new-app-dialog
- **The connected GitHub account is a real source.** The account in Settings > GitHub > "Private repositories without the App" now lists its repositories, reads branches, clones and deploys on push, like an App installation. Pushes come through a webhook the panel creates on the repository when the panel has a domain and the token may create webhooks; otherwise the branch is polled every minute, and the Source tab says why. One account per panel, and every service connected through it uses its token. Organizations that restrict OAuth apps have to approve the panel first; the App needs no approval.
- **Use a token** instead of the device login: a fine-grained token with Contents: Read and Metadata: Read (plus Webhooks: Read and write for push-to-deploy), or a classic one with `repo`. The panel checks it with GitHub before saving, and it works without GitHub sign-in set up.
- **Git credentials in the panel.** "Add credential" next to the Credential picker on a Git source adds a token or an SSH key (generated or pasted), with host keys read from the host or pasted as known_hosts lines (`[host]:port` when the port is not 22). Settings > Git providers lists them, with Edit and Delete. Before, only the API could add one.
- **Confirm with GitHub** in the "Confirm it's you" dialog, so an account that signs in only with GitHub no longer has to sign in again for each sensitive change. Only the GitHub login linked to the account counts.
- **A console on the Overview**, under Deploys. It only watches, and is not in the activity log, until you type a line.
- A **+** next to each project in the sidebar starts a new service in it.
- A deploy of a plain git URL on GitHub, GitLab or Bitbucket that fails to clone without a credential says how to connect a private repository.

## Changed

- **One Console tab** with a Console | Shell switch in place. Old `/shell` links open it in shell mode.
- The Git repository tab in New app is a plain URL field for any host. GitHub repositories go through the GitHub tab.
- **Port starts at 80** in New app (or the port a Docker Hub image exposes), and apps built from a repository get it as `PORT` unless they set `PORT` themselves. Only apps created on 0.2.2 or later: existing apps keep their environment.
- Deploy titles come from the deploy: its commit, else "Deploy from <branch>", else "Deploy from <archive name>" for an upload.
- While a webhook delivers a service's pushes, the panel reads its GitHub branch every 5 minutes as a safety net, instead of every minute. Without a panel domain or a working webhook it still reads it every minute.
- Approvals shows in the sidebar only once MCP or the assistant is on, or while a request waits for you.
- The sidebar logo and panel name go to the dashboard. Hide project works as before.
- Root directory is set once, in the Build section of the Source tab.
- A cosmetic pass over every screen: phone layouts, dark themes without 1px outlines, one Save per settings card.

## Fixed

- An API or MCP client could save a git credential whose known_hosts lines did not name its host, so every clone over SSH failed its host key check. Such text is now refused, and so is text with hashed lines (`|1|...`), which the panel cannot match.
- Deploy titles could show the panel's internal registry address (`127.0.0.1:5755/...`).
- Leaving a console, or switching between console and shell, while the session was being set up could leave a connection open.

## After you update

- Apps created before 0.2.2 get no `PORT`. Add `PORT=<port>` to an app's `.env` and deploy if you want it.
- A GitHub account connected on 0.2.1 becomes the connected account. Services that clone with it through a Git source keep working; connect the repository through GitHub on the Source tab to get a webhook.
