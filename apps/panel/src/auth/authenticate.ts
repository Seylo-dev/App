// Turns request credentials into a principal. A bearer token wins over the
// session cookie so scripts never pick up a browser session by accident.

import type { PanelDb } from "../db/client";
import { lookupApiKey } from "./api-keys";
import { anonymous, type Principal } from "./principal";
import { lookupSession } from "./sessions";

export interface Credentials {
  sessionToken?: string;
  bearerToken?: string;
}

/** Unknown or expired credentials yield the anonymous principal; ops then refuse with UNAUTHENTICATED. */
export function authenticate(db: PanelDb, credentials: Credentials, now = new Date()): Principal {
  if (credentials.bearerToken) {
    return lookupApiKey(db, credentials.bearerToken, now) ?? anonymous;
  }
  if (credentials.sessionToken) {
    const session = lookupSession(db, credentials.sessionToken, now);
    if (session) return { type: "session", ...session };
  }
  return anonymous;
}

/** Reads the session cookie and Authorization header from a request. */
export function credentialsFrom(request: Request, cookieName: string): Credentials {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const sessionToken = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(cookieName) ?? undefined;
  return { bearerToken: bearer, sessionToken };
}
