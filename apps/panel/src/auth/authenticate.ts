// Turns request credentials into a principal. A bearer token wins over the
// session cookie so scripts never pick up a browser session by accident.
// A browser session needs both halves: the cookie and the session key the
// web app sends in a header (auth/sessions.ts explains why).

import { OpError, sessionCookieName, sessionKeyHeader } from "@seylo/ops";
import type { PanelDb } from "../db/client";
import { lookupApiKey } from "./api-keys";
import { anonymous, type Principal } from "./principal";
import { lookupSession } from "./sessions";

export interface Credentials {
  sessionToken?: string;
  /** The session key from the request's header (or the live socket's query); see sessionKeyHeader. */
  sessionKey?: string;
  bearerToken?: string;
  /**
   * The request carried the session cookie more than once. Another site on
   * the same host can add a second cookie with a longer path, which browsers
   * send first; such requests are refused rather than guessed at.
   */
  duplicateSession?: boolean;
}

/**
 * Unknown or expired credentials yield the anonymous principal; ops then
 * refuse with UNAUTHENTICATED. touch: false checks a session without
 * counting as a use of it (the live socket's checks; see auth/sessions.ts).
 */
export function authenticate(db: PanelDb, credentials: Credentials, now = new Date(), options: { touch?: boolean } = {}): Principal {
  if (credentials.bearerToken) {
    return lookupApiKey(db, credentials.bearerToken, now) ?? anonymous;
  }
  if (credentials.sessionToken && credentials.sessionKey && !credentials.duplicateSession) {
    const session = lookupSession(db, credentials.sessionToken, credentials.sessionKey, now, options);
    if (session) return { type: "session", ...session };
  }
  return anonymous;
}

/** The error for a signed-in op called without working credentials. */
export function signedOutError(credentials: Credentials): OpError {
  if (credentials.duplicateSession && !credentials.bearerToken) {
    return new OpError(
      "UNAUTHENTICATED",
      "This browser sent two session cookies for this panel, so neither is used. Another site on the same address may have set one: clear this site's cookies, then sign in again.",
      { reason: "duplicateSession" },
    );
  }
  return new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
}

export interface CredentialOptions {
  /**
   * Whether the session cookie is the Secure `__Host-` one: the request came
   * over HTTPS (or the panel always sets Secure). Only that name is read
   * then, so a plain cookie planted by a sibling host is ignored.
   */
  secure: boolean;
  /** The session key when it cannot come in a header (the live socket's query parameter). */
  sessionKey?: string | null;
}

/** Reads the session cookie, the session key and the Authorization header from a request. */
export function credentialsFrom(request: Request, options: CredentialOptions): Credentials {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const tokens = cookieValues(request.headers.get("cookie"), sessionCookieName(options.secure));
  const key = options.sessionKey ?? request.headers.get(sessionKeyHeader);
  return {
    bearerToken: bearer,
    sessionToken: tokens.length === 1 ? tokens[0] : undefined,
    sessionKey: key || undefined,
    duplicateSession: tokens.length > 1,
  };
}

/** Every value the Cookie header holds for `name` (Bun.CookieMap would keep only the first of repeated names). */
function cookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0 || pair.slice(0, at).trim() !== name) continue;
    const value = pair.slice(at + 1).trim();
    if (value) values.push(safeDecode(value));
  }
  return values;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
