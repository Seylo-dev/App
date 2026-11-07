// The server-rendered pages of the OAuth flow: the bridge, consent and
// messages. They are plain HTML (no web app bundle) so they work before the
// SPA loads; colors follow the default light theme. They refuse to be
// framed. The only script is the bridge's, allowed by its hash.

import { createHash } from "node:crypto";
import { sessionKeyStorage } from "@seylo/ops";

/** Form field carrying the session key (the consent page has no headers to put it in). */
export const sessionKeyField = "session_key";

interface ConsentPage {
  panelName: string;
  clientName: string;
  redirectHost: string;
  userLabel: string;
  /** The authorize request as hidden fields. */
  fields: [string, string][];
  /** The scope the client asked for; shown, never used to preselect a choice. */
  requestedScope: string;
  csrf: string;
  sessionKey: string;
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
.note{font-size:13px;margin-top:14px}
.tag{display:inline-block;font-size:12px;line-height:1.4;padding:1px 6px;border-radius:6px;background:var(--danger-bg);color:#b91c1c;margin-left:4px}`;

function page(title: string, body: string, status = 200, script?: { source: string; hash: string }): Response {
  const scriptTag = script ? `<script>${script.source}</script>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="referrer" content="no-referrer" /><title>${escapeHtml(title)}</title><style>${styles}</style></head><body><main>${body}</main>${scriptTag}</body></html>`;
  const scripts = script ? `; script-src '${script.hash}'` : "";
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'${scripts}; frame-ancestors 'none'; base-uri 'none'`,
      "referrer-policy": "no-referrer",
    },
  });
}

function hiddenFields(fields: [string, string][]): string {
  return fields.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`).join("");
}

/**
 * Copies the session key from the web app's storage into the form and posts
 * it; without a key the person is not signed in on this origin, so it goes
 * to sign-in. Static text, so its CSP hash is fixed.
 */
const bridgeSource = `(function(){var f=document.getElementById("bridge");var k=null;try{k=window.localStorage.getItem(${JSON.stringify(sessionKeyStorage)})}catch(e){}if(!k){window.location.replace(f.getAttribute("data-login"));return}f.elements.namedItem(${JSON.stringify(sessionKeyField)}).value=k;f.submit()})();`;
const bridgeScript = { source: bridgeSource, hash: `sha256-${createHash("sha256").update(bridgeSource).digest("base64")}` };

/** GET /oauth/authorize: posts the request back with the session key (oauth.ts authorizeDecision). */
export function bridgePage(input: { panelName: string; fields: [string, string][]; back: string }): Response {
  const login = `/login?redirect=${encodeURIComponent(input.back)}`;
  const body = `
<div class="brand">${escapeHtml(input.panelName)}</div>
<h1>Connecting an app</h1>
<noscript><p>Turn on JavaScript for this panel to continue.</p></noscript>
<form id="bridge" method="post" action="/oauth/authorize" data-login="${escapeHtml(login)}">
${hiddenFields([...input.fields, [sessionKeyField, ""]])}
</form>`;
  return page("Connecting an app", body, 200, bridgeScript);
}

export function messagePage(panelName: string, title: string, message: string, status: number): Response {
  return page(title, `<div class="brand">${escapeHtml(panelName)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, status);
}

export function consentPage(input: ConsentPage): Response {
  const hidden = hiddenFields([...input.fields, ["csrf", input.csrf], [sessionKeyField, input.sessionKey]]);
  const asksWrite = input.requestedScope.split(/\s+/).includes("mcp:write");
  // Anyone can register a client under any name, so the name is marked as
  // unverified and the address the answer goes to is what identifies it.
  // Read only is always the preselected choice, whatever the app asked for.
  const body = `
<div class="brand">${escapeHtml(input.panelName)}</div>
<h1>Connect an app at ${escapeHtml(input.redirectHost)}?</h1>
<p>An app that calls itself <strong>${escapeHtml(input.clientName)}</strong><span class="tag">name not verified</span> wants to use this panel's tools as <strong>${escapeHtml(input.userLabel)}</strong>. After you answer, you return to <strong>${escapeHtml(input.redirectHost)}</strong>. Allow it only if you just started this from an app there.</p>
<p class="note">It asked for ${asksWrite ? "read and change access" : "read only access"}.</p>
<form method="post" action="/oauth/authorize">
${hidden}
<label class="choice"><input type="radio" name="access" value="read" checked /><div><strong>Read only</strong><span>Look at projects, services, logs and settings. Nothing can be changed.</span></div></label>
<label class="choice"><input type="radio" name="access" value="write" /><div><strong>Read and change</strong><span>Also deploy, restart and edit. Deleting anything still waits for your approval.</span></div></label>
<p class="note">It never gets more than your own permissions. You can revoke it any time in Settings.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`;
  return page("Connect an app", body);
}
