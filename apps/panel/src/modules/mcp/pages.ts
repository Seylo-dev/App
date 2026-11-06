// The two server-rendered pages of the OAuth flow: consent and messages.
// They are plain HTML (no web app bundle) so they work before the SPA
// loads; colors follow the default light theme. They refuse to be framed.

interface ConsentPage {
  panelName: string;
  clientName: string;
  redirectHost: string;
  userLabel: string;
  params: { clientId: string; redirectUri: string; state: string | null; codeChallenge: string; scope: string };
  csrf: string;
  defaultWrite: boolean;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const styles = `
:root{color-scheme:light;--ground:#f3f6fb;--card:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--primary:#2563eb;--danger-bg:#fef2f2}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--ground);
font:15px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
main{width:100%;max-width:440px;background:var(--card);border-radius:12px;box-shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.08);padding:28px}
h1{font-size:19px;margin:0 0 6px}p{margin:0 0 14px;color:var(--muted)}strong{color:var(--text)}
.brand{font-size:13px;color:var(--muted);margin-bottom:18px}
label.choice{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer}
label.choice span{display:block;font-size:13px;color:var(--muted)}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
button{font:inherit;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
.note{font-size:13px;margin-top:14px}`;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="referrer" content="no-referrer" /><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

export function messagePage(panelName: string, title: string, message: string, status: number): Response {
  return page(title, `<div class="brand">${escapeHtml(panelName)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status);
}

export function consentPage(input: ConsentPage): Response {
  const hidden = [
    ["client_id", input.params.clientId],
    ["redirect_uri", input.params.redirectUri],
    ["response_type", "code"],
    ["code_challenge", input.params.codeChallenge],
    ["code_challenge_method", "S256"],
    ["scope", input.params.scope],
    ["csrf", input.csrf],
    ...(input.params.state !== null ? [["state", input.params.state]] : []),
  ]
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name as string)}" value="${escapeHtml(value as string)}" />`)
    .join("");
  const body = `
<div class="brand">${escapeHtml(input.panelName)}</div>
<h1>Connect ${escapeHtml(input.clientName)}?</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> wants to use this panel's tools as <strong>${escapeHtml(input.userLabel)}</strong>. After you allow it, you return to <strong>${escapeHtml(input.redirectHost)}</strong>.</p>
<form method="post" action="/oauth/authorize">
${hidden}
<label class="choice"><input type="radio" name="access" value="read" ${input.defaultWrite ? "" : "checked"} /><div><strong>Read only</strong><span>Look at projects, services, logs and settings. Nothing can be changed.</span></div></label>
<label class="choice"><input type="radio" name="access" value="write" ${input.defaultWrite ? "checked" : ""} /><div><strong>Read and change</strong><span>Also deploy, restart and edit. Deleting anything still waits for your approval.</span></div></label>
<p class="note">It never gets more than your own permissions. You can revoke it any time in Settings.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`;
  return page(`Connect ${input.clientName}`, body);
}
