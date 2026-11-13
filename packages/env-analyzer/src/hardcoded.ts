// A built-in address of another service, or of this one, written out by
// hand: NEXT_PUBLIC_API=https://api.example.com instead of ${{api.URL}}.
// It works until that domain or port changes, then breaks quietly, so the
// analyzer offers the reference as an info hint with a quick fix. Values can
// be secrets and the MCP server hands diagnostics to models, so the message,
// detail, params and fix name the key and the reference, never the value.

import { listItems } from "./builtins";
import { missingNodes } from "./nodes";
import { formatReference } from "./references";
import type { LineIndex } from "./source";
import type { AnalyzeContext, Diagnostic, EnvEntry, QuickFix, ReferenceTarget, ReferenceVariable, SourceRange } from "./types";

const urlVariables: readonly string[] = ["URL", "EXPOSED_URL", "INTERNAL_URL"];
/**
 * Built-ins a whole value is compared with as a host name. Not EXPOSED_HOST:
 * a database's is the node's own address unless it has a TLS host name, so
 * SSH_HOST=<the node> would be told to use the database's exposure (and go
 * empty when exposure is turned off). Its EXPOSED_URL, with the port and the
 * user, is specific enough and still matches. DOMAINS, a list, is compared
 * whole when it has two or more hosts (ALLOWED_HOSTS=a.com,b.com) and item
 * by item (WWW_HOST=b.com, its DOMAINS[1]).
 */
const hostVariables: readonly string[] = ["DOMAIN", "DOMAINS", "INTERNAL_HOST"];
/** Among equal matches of one target, the public variable first; DOMAIN before DOMAINS[0], the same host. */
const preference: readonly string[] = ["URL", "EXPOSED_URL", "DOMAIN", "DOMAINS", "INTERNAL_URL", "INTERNAL_HOST"];

/**
 * Name prefixes bundlers put into browser code: Next.js, Vite, SvelteKit and
 * Astro, Create React App, Nuxt, Expo, Gatsby, Vue CLI. A browser cannot
 * reach the project network, so these need a public address.
 */
export const browserPrefixes = [
  "NEXT_PUBLIC_",
  "VITE_",
  "PUBLIC_",
  "REACT_APP_",
  "NUXT_PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "VUE_APP_",
] as const;

export function isBrowserVariable(key: string): boolean {
  return browserPrefixes.some((prefix) => key.startsWith(prefix));
}

/** Keys that name a host or a domain: a whole value is compared with a host name only for them. */
const hostKey = /(HOST|HOSTNAME|HOST_NAME|HOSTS|ADDR|ADDRESS|SERVER|SERVER_NAME|DOMAIN|DOMAINS)$/i;

/** Keys of mail settings: a mail domain often reads like a site's (MAIL_DOMAIN=example.com) but is its own setting. */
const mailKey = /(^|_)(E?MAIL[A-Z0-9]*|SMTP|IMAP|POP3?|MX)(_|$)/i;

interface Candidate {
  target: ReferenceTarget;
  /** One of the edited service's own built-ins (its URL, DOMAIN, ...). */
  self: boolean;
  variable: ReferenceVariable;
  /** The n of one item of a list (DOMAINS[1]); null for the whole value. */
  index: number | null;
  value: string;
}

interface Match {
  candidate: Candidate;
  /** Characters of the value, from its start, that the built-in covers. */
  length: number;
}

/** The hardcoded-reference hint for one entry, or nothing. The caller skips entries with syntax problems. */
export function checkHardcoded(index: LineIndex, entry: EnvEntry, context: AnalyzeContext): Diagnostic[] {
  const quoted = entry.quote !== "none";
  const start = entry.valueRange.start + (quoted ? 1 : 0);
  const end = entry.valueRange.end - (quoted ? 1 : 0);
  if (end <= start) return [];
  const raw = index.text.slice(start, end);

  const match = bestMatch(raw, entry.key, candidates(context));
  if (!match) return [];
  const matchEnd = start + match.length;
  if (entry.references.some((r) => start < r.range.end && matchEnd > r.range.start)) return [];

  const { target, variable, self } = match.candidate;
  const internal = variable.scope === "internal";
  // An internal address of a service on another node already has an error, with the exposed variant as its fix.
  if (internal && !self && missingNodes(context.self.nodes, target.nodes).length > 0) return [];

  const browser = isBrowserVariable(entry.key);
  const kind = urlVariables.includes(variable.name) ? "url" : "host";
  const range = index.range(start, matchEnd);
  // Browsers cannot reach the project network: a browser variable gets the public address.
  const publicName = internal && browser ? counterpart(target, kind, "public") : null;
  if (internal && browser && !publicName) return [unreachable(entry, target, variable, kind, range)];
  const suggested = publicName ?? variable.name;
  // One item of a list keeps its index (DOMAINS[1]); a public counterpart is a whole variable.
  const at = publicName ? null : match.candidate.index;
  const reference = formatReference(target.name, suggested, at);
  const matched = match.candidate.index === null ? variable.name : `${variable.name}[${match.candidate.index}]`;
  const reason = publicName ? "public" : "same";
  // Where INTERNAL_URL is worth a word: next to another service's public URL (a host alone would need the port too).
  const internalName = self || kind !== "url" || (internal && !browser) ? null : counterpart(target, kind, "internal");
  const internalReference = internalName ? formatReference(target.name, internalName) : "";

  const sentences: string[] = [];
  if (reason === "same") {
    sentences.push(
      `This is ${target.name}'s ${matched} written out. ${reference} gives the same value and stays right when ${target.name}'s address changes.`,
    );
  } else {
    sentences.push(
      `${entry.key} is read in the browser, which cannot reach ${target.name}'s internal address, so the fix uses its public one.`,
    );
  }
  if (internalReference && browser) {
    sentences.push(`A server-side variable can use ${internalReference} instead when both services share a node.`);
  } else if (internalReference) {
    sentences.push(`Read on the server, ${entry.key} can also use ${internalReference} when both services share a node.`);
  }

  return [
    {
      code: "hardcoded-reference",
      severity: "info",
      message: `${entry.key} can use ${reference}`,
      detail: sentences.join(" "),
      params: {
        key: entry.key,
        target: target.name,
        variable: suggested,
        matched,
        reference,
        reason,
        browser: String(browser),
        internalReference,
        publicReference: "",
      },
      range,
      fixes: fixFor(index, entry, raw, match.length, matchEnd, reference),
    },
  ];
}

/**
 * A browser variable with the internal address of a service that has no
 * public one. The internal reference would not work in a browser either, so
 * there is no fix and no "can use": the hint names the public variable to
 * use once the service has an address (publicReference, empty when its kind
 * has none).
 */
function unreachable(
  entry: EnvEntry,
  target: ReferenceTarget,
  variable: ReferenceVariable,
  kind: "url" | "host",
  range: SourceRange,
): Diagnostic {
  const later = (kind === "url" ? ["URL", "EXPOSED_URL"] : ["DOMAIN", "EXPOSED_HOST"]).find((name) =>
    target.variables.some((v) => v.name === name && v.scope === "public"),
  );
  const publicReference = later ? formatReference(target.name, later) : "";
  const then = publicReference
    ? `Give ${target.name} a public address, then use ${publicReference}.`
    : `Give ${target.name} a public address and use that instead.`;
  return {
    code: "hardcoded-reference",
    severity: "info",
    message: `${entry.key} uses ${target.name}'s internal address, which browsers cannot reach`,
    detail: `${entry.key} is read in the browser, which cannot reach ${target.name}'s internal address. ${then}`,
    params: {
      key: entry.key,
      target: target.name,
      variable: "",
      matched: variable.name,
      reference: "",
      reason: "noPublic",
      browser: "true",
      internalReference: "",
      publicReference,
    },
    range,
    fixes: [],
  };
}

/** The reference over the matched text, first edit (UIs title the fix by it); single quotes also become double ones. */
function fixFor(index: LineIndex, entry: EnvEntry, raw: string, length: number, matchEnd: number, reference: string): QuickFix[] {
  const replace = { range: index.range(matchEnd - length, matchEnd), text: reference };
  const title = `Use ${reference}`;
  if (entry.quote !== "single") return [{ kind: "edit", title, edits: [replace] }];
  // Single quotes take no references: the value moves to double quotes when the rest reads the same there.
  if (/["\\\r]|\$\{\{/.test(raw.slice(length))) return [];
  const { start, end } = entry.valueRange;
  const quote = (at: number) => ({ range: index.range(at, at + 1), text: '"' });
  return [{ kind: "edit", title, edits: [replace, quote(start), quote(end - 1)] }];
}

/** Built-in addresses with a value: the edited service's own first, then every other service's. Shared variables have none. */
function candidates(context: AnalyzeContext): Candidate[] {
  const out: Candidate[] = [];
  const add = (target: ReferenceTarget, self: boolean) => {
    for (const variable of target.variables) {
      if (variable.scope === "plain" || !(urlVariables.includes(variable.name) || hostVariables.includes(variable.name))) continue;
      if (!variable.value) continue;
      if (!variable.list) {
        out.push({ target, self, variable, index: null, value: variable.value });
        continue;
      }
      // A list whole when it has two or more items (one is its first item), and each item.
      const items = listItems(variable.value);
      if (items.length >= 2) out.push({ target, self, variable, index: null, value: variable.value });
      items.forEach((item, index) => {
        if (item) out.push({ target, self, variable, index, value: item });
      });
    }
  };
  const selfName = context.self.name;
  if (selfName && context.self.builtins?.length) {
    add(
      {
        name: selfName,
        kind: "service",
        serviceId: context.self.serviceId,
        serviceKind: null,
        nodes: context.self.nodes,
        internalHost: selfName,
        exposed: true,
        variables: context.self.builtins,
      },
      true,
    );
  }
  for (const target of context.targets) {
    if (target.kind !== "service" || target.name.toLowerCase() === selfName.toLowerCase()) continue;
    add(target, false);
  }
  return out;
}

/** The longest match; none when two services share it (the same address says nothing about which one is meant). */
function bestMatch(raw: string, key: string, list: readonly Candidate[]): Match | null {
  let best: Match[] = [];
  for (const candidate of list) {
    const length = hostVariables.includes(candidate.variable.name) ? hostMatch(raw, candidate, key) : urlMatch(raw, candidate.value);
    if (length <= 0) continue;
    const top = best[0]?.length ?? 0;
    if (length > top) best = [{ candidate, length }];
    else if (length === top) best.push({ candidate, length });
  }
  if (new Set(best.map((m) => m.candidate.target.name.toLowerCase())).size !== 1) return null;
  const rank = (m: Match) => preference.indexOf(m.candidate.variable.name);
  return best.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/**
 * The whole value is the host (case-insensitive), for a key that names a
 * host or a domain: a host name alone says little about what the variable
 * is for, a URL with its scheme does.
 */
function hostMatch(raw: string, candidate: Candidate, key: string): number {
  const host = candidate.value;
  if (genericHost(host) || !hostKey.test(key)) return -1;
  if ((candidate.variable.name === "DOMAIN" || candidate.variable.name === "DOMAINS") && mailKey.test(key)) return -1;
  return raw.toLowerCase() === host.toLowerCase() ? raw.length : -1;
}

const urlShape = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)([\s\S]*)$/i;

/**
 * How much of raw the URL covers: all of it, or its start when a path,
 * query or fragment follows ("https://api.example.com/v1"). Scheme and host
 * compare case-insensitively, a trailing slash is ignored.
 */
function urlMatch(raw: string, url: string): number {
  const want = urlShape.exec(url);
  const have = urlShape.exec(raw);
  if (!want || !have) return -1;
  const [, scheme = "", authority = "", path = ""] = want;
  const [, rawScheme = "", rawAuthority = "", rawPath = ""] = have;
  if (authority === "" || genericAuthority(authority)) return -1;
  if (rawScheme.toLowerCase() !== scheme.toLowerCase() || !sameAuthority(rawAuthority, authority)) return -1;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!rawPath.startsWith(trimmed)) return -1;
  const next = rawPath.charAt(trimmed.length);
  // After a built-in with a query ("...?sslmode=require"), more parameters follow with "&".
  const follows = trimmed.includes("?") ? "&#" : "/?#";
  if (next !== "" && !follows.includes(next)) return -1;
  // A built-in that ends in "/" brings its own: the value's slash is replaced with it.
  const slash = trimmed !== path && next === "/" ? 1 : 0;
  return rawScheme.length + rawAuthority.length + trimmed.length + slash;
}

/** User info compares exactly, host and port case-insensitively. */
function sameAuthority(a: string, b: string): boolean {
  const split = (s: string) => {
    const at = s.lastIndexOf("@");
    return [s.slice(0, at + 1), s.slice(at + 1).toLowerCase()] as const;
  };
  const [userA, hostA] = split(a);
  const [userB, hostB] = split(b);
  return userA === userB && hostA === hostB;
}

/** localhost or a loopback address anywhere; a bare IP without a port or user (many services share one). */
function genericAuthority(authority: string): boolean {
  const at = authority.lastIndexOf("@");
  const hostPort = authority.slice(at + 1);
  const bracket = hostPort.startsWith("[") ? hostPort.indexOf("]") : -1;
  const colon = bracket >= 0 ? hostPort.indexOf(":", bracket) : hostPort.lastIndexOf(":");
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const hasPort = colon >= 0;
  if (isLoopback(host)) return true;
  return isIp(host) && !hasPort && at < 0;
}

/** Hosts too common to mean one service: localhost, IP addresses, plain numbers. */
function genericHost(host: string): boolean {
  return isLoopback(host) || isIp(host) || /^\d+$/.test(host);
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function isIp(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(":") && /^[0-9a-f:.]+$/i.test(h));
}

/** The public or internal variable of the same shape (URL or host) the target has a value for. */
function counterpart(target: ReferenceTarget, kind: "url" | "host", scope: "public" | "internal"): string | null {
  const names =
    scope === "public"
      ? kind === "url"
        ? ["EXPOSED_URL", "URL"]
        : ["EXPOSED_HOST", "DOMAIN"]
      : [kind === "url" ? "INTERNAL_URL" : "INTERNAL_HOST"];
  for (const name of names) {
    if (target.variables.some((v) => v.name === name && v.scope === scope && v.value)) return name;
  }
  return null;
}
