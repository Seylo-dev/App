// Package troubleshoot builds the `seylo troubleshoot` report: versions,
// node health check results, the agent's systemd state, Docker, our
// containers, config.yml, recent errors from the agent's and Docker's
// journals, the agent log tail and (optionally) service logs, as Markdown.
// Every line goes through Redact: tokens, keys, passwords (also in URLs and
// assignments like DB_PASSWORD=...), setup and ticket links, PEM private
// keys and email addresses become [REDACTED]; public IPs too with
// RedactIPs. The rules are a superset of the site API's refusal rules
// (in the private Website repo), so a redacted report is never refused.
//
// Upload posts the report to <site>/l (text body, at most 512 KiB) and
// returns the link, its expiry and a delete token; a 422 from the site
// becomes a RefusedError naming the rules and lines.
//
// Interfaces used by other packages:
//
//   - Run / Build: the CLI command and the Troubleshoot RPC handler.
//   - Redact: anything else that ships text off the node.
package troubleshoot
