// Adapts HTTP requests to the op pipeline: reads credentials, runs the op,
// and turns the outcome (plus any cookies the handler set) into a Response.

import { OpError, sessionCookie } from "@seylo/ops";
import { errorResponse, type OpHttpCall } from "@seylo/ops/elysia";
import { credentialsFrom } from "../auth/authenticate";
import type { Deps } from "../deps";
import type { CookieOptions, HttpEffects } from "../ops/implement";
import type { ExecuteOp } from "../ops/pipeline";
import { clientIp } from "./client-ip";
import { servedOverHttps } from "./https";
import { isSameOrigin } from "./origin";
import { requestOrigin } from "./request-origin";

export function httpOpHandler(execute: ExecuteOp, deps: Pick<Deps, "config" | "db" | "proxy">) {
  return async ({ op, rawInput, request, socketIp }: OpHttpCall): Promise<Response> => {
    const headers = new Headers({ "cache-control": "no-store" });
    const trusted = deps.proxy.trusts(socketIp);
    const credentials = credentialsFrom(request, sessionCookie);
    if (!credentials.bearerToken && op.kind !== "query" && !isSameOrigin(request)) {
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
      // Secure on every HTTPS response, so a session made on the panel domain
      // is never sent over plain HTTP; IP:port sign-in keeps working.
      http: cookieEffects(headers, deps.config.secureCookies || servedOverHttps(deps, request, socketIp)),
      origin: requestOrigin(request, trusted),
    });
    if (outcome.ok) return Response.json(outcome.output, { headers });
    return withRetryAfter(outcome.error, headers);
  };
}

function withRetryAfter(error: OpError, headers: Headers): Response {
  const retryAfter = error.details?.retryAfter;
  if (error.code === "RATE_LIMITED" && retryAfter) headers.set("retry-after", retryAfter);
  return errorResponse(error, headers);
}

function cookieEffects(headers: Headers, secure: boolean): HttpEffects {
  const set = (name: string, value: string, options: CookieOptions & { expires?: Date }) => {
    const cookie = new Bun.Cookie(name, value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: options.maxAgeSeconds,
      expires: options.expires,
    });
    headers.append("set-cookie", cookie.serialize());
  };
  return {
    setCookie: (name, value, options = {}) => set(name, value, options),
    clearCookie: (name) => set(name, "", { maxAgeSeconds: 0, expires: new Date(0) }),
  };
}
