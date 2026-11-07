// Turns the generated module map (src/ops/index.gen.ts) into the flat list
// of contracts the generators and the panel work with.

import { slug } from "@seylo/brand";
import { type AnyOpContract, isOpContract, moduleOf } from "./define";

export type OpModuleMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Collects every exported contract, sorted by id. Throws when an id is
 * used twice or does not start with the name of the file that defines it,
 * which keeps "where is projects.create?" answerable without a search.
 */
export function collectOps(modules: OpModuleMap): AnyOpContract[] {
  const byId = new Map<string, AnyOpContract>();
  for (const [moduleName, exports] of Object.entries(modules)) {
    for (const value of Object.values(exports)) {
      if (!isOpContract(value)) continue;
      if (moduleOf(value) !== moduleName) {
        throw new Error(`op ${value.id} is defined in src/ops/${moduleName}.ts; its id must start with "${moduleName}."`);
      }
      if (byId.has(value.id)) {
        throw new Error(`op id ${value.id} is defined twice`);
      }
      byId.set(value.id, value);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The HTTP route of an op: queries are GETs, everything else POSTs. */
export function opRoute(op: Pick<AnyOpContract, "id" | "kind">): { method: "GET" | "POST"; path: string } {
  return { method: op.kind === "query" ? "GET" : "POST", path: `${apiPrefix}/${op.id}` };
}

export const apiPrefix = "/api/v1";

/**
 * Cookie holding the browser session token (HttpOnly; set by auth.login) on
 * plain HTTP. Cookies ignore ports, so on an IP:port panel the browser also
 * sends it to every other port of that address: on its own it signs nobody
 * in (see sessionKeyHeader).
 */
export const sessionCookie = `${slug}_session`;

/** The session cookie's name over HTTPS: the `__Host-` prefix keeps sibling hosts from setting or shadowing it. */
export const secureSessionCookie = `__Host-${sessionCookie}`;

/** The session cookie's name for a response or request: `__Host-` when the cookie is Secure. */
export function sessionCookieName(secure: boolean): string {
  return secure ? secureSessionCookie : sessionCookie;
}

/**
 * The other half of a browser session. Sign-in answers carry it in this
 * response header; the web app keeps it in its origin's localStorage (which,
 * unlike cookies, is per scheme, host and port) and sends it back in this
 * header on every call. A session cookie without its key is refused, so a
 * cookie another port of the same address received is useless.
 */
export const sessionKeyHeader = `x-${slug}-session-key`;

/** The web app's localStorage entry for the session key (the MCP consent page reads it too). */
export const sessionKeyStorage = `${slug}.sessionKey`;
