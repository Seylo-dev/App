# Security

## Reporting a vulnerability

Report security problems privately through GitHub: on
[Seylo-dev/App](https://github.com/Seylo-dev/App), open the Security tab and
use "Report a vulnerability"
([direct link](https://github.com/Seylo-dev/App/security/advisories/new)).
Do not open a public issue, pull request or discussion for it.

Please include:

- what an attacker can do, and what they need first (no account, a member
  or admin account, an API or MCP key, control of a node, a position on the
  network between the panel and a node);
- the affected version (`seylo version` on a node, Settings > Updates in
  the panel) and how it was installed;
- steps to reproduce: requests, commands or a proof of concept;
- logs or a `seylo troubleshoot --dry-run` report if they help, with your
  own secrets removed.

We reply on the advisory, work out the fix with you there, and publish the
advisory with the release that fixes it. Tell us if you want to be credited.

## Supported versions

Only the latest release gets security fixes. The panel updates itself and
every node from Settings > Updates, so moving to the latest release is one
switch.

## Scope

In scope: the `seylo` binary (node agent, node CLI and laptop CLI), the
panel and its web app, the installer, release signing and the update path,
and the templates in `templates/`.

Out of scope: the apps you deploy with Seylo, and the third-party images
that templates or database tools use (report those to their projects).

The minisign secret key in `test/e2e-colima/keys` is committed on purpose:
it signs the end-to-end test's local releases only, release builds refuse
it, and no real install trusts it (see that folder's README).
