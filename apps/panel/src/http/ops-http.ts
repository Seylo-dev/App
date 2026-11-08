// Adapts HTTP requests to the op pipeline: reads credentials, runs the op,
// and turns the outcome (plus the session the handler set) into a Response.

import { OpError, sessionCookieName, sessionKeyHeader } from "@seylo/ops";
import { errorResponse, type OpHttpCall } from "@seylo/ops/elysia";
import { credentialsFrom } from "../auth/authenticate";
import type { Deps } from "../deps";
import type { HttpEffects } from "../ops/implement";
import type { ExecuteOp } from "../ops/pipeline";
import { clientIp } from "./client-ip";
import { jsonResponse } from "./compress";
import { secureSession } from "./https";
import { isSameOrigin } from "./origin";
import { requestOrigin } from "./request-origin";

export function httpOpHandler(execute: ExecuteOp, deps: Pick<Deps, "config" | "db" | "proxy">) {
  return async ({ op, rawInput, request, socketIp }: OpHttpCall): Promise<Response> => {
    const headers = new Headers({ "cache-control": "no-store" });
    const trusted = deps.proxy.trusts(socketIp);
    const secure = secureSession(deps, request, socketIp);
    const credentials = credentialsFrom(request, { secure });
    if (!credentials.bearerToken && op.kind !== "query" && !isSameOrigin(request, trusted)) {
      return errorResponse(new OpError("FORBIDDEN", "Cross-site requests cannot change anything."), headers);
    }
    const outcome = await execute({
      op,
      rawInput,
      credentials,
      transport: "http",
      coerce: op.kind === "query",
      ip: clientIp(request, socketIp, trusted),
      userAgent: request.headers.get("user-agent"),
      http: sessionEffects(headers, secure),
      origin: requestOrigin(request, trusted),
    });
    if (outcome.ok) return jsonResponse(request, outcome.output, headers);
    return withRetryAfter(outcome.error, headers);
  };
}

function withRetryAfter(error: OpError, headers: Headers): Response {
  const retryAfter = error.details?.retryAfter;
  if (error.code === "RATE_LIMITED" && retryAfter) headers.set("retry-after", retryAfter);
  return errorResponse(error, headers);
}

/** The session cookie (`__Host-` and Secure on HTTPS, path /, no domain) and the session key header. */
function sessionEffects(headers: Headers, secure: boolean): HttpEffects {
  const cookie = (value: string, maxAge: number, expires?: Date) =>
    headers.append(
      "set-cookie",
      new Bun.Cookie(sessionCookieName(secure), value, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge, expires }).serialize(),
    );
  return {
    setSession({ token, key, maxAgeSeconds }) {
      cookie(token, maxAgeSeconds);
      headers.set(sessionKeyHeader, key);
    },
    clearSession() {
      cookie("", 0, new Date(0));
      // An empty key tells the web app to forget the one it holds.
      headers.set(sessionKeyHeader, "");
    },
  };
}
