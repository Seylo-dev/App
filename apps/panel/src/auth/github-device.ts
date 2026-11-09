// GitHub OAuth device flow (like `gh auth login`) with the org-owned OAuth
// App's public client id: no client secret ships with the panel, and it
// works while the panel is still on a bare IP. Used for owner sign-up,
// sign-in, linking a GitHub login and confirming it's you with it. The device code never leaves the
// panel: the browser polls with an auth_challenges ticket instead.
//
// Endpoints: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

import { isPlaceholder, oauthClientId, slug } from "@seylo/brand";
import { OpError } from "@seylo/ops";
import type { Config } from "../config";
import type { PanelDb } from "../db/client";
import type { ChallengePurpose } from "../db/schema";
import type { SecretBox } from "../security/secret-box";
import { type Challenge, createChallenge, deleteChallenge, updateChallengeData } from "./challenges";

export interface GithubEndpoints {
  clientId: string;
  /** https://github.com */
  loginBase: string;
  /** https://api.github.com */
  apiBase: string;
  fetch: typeof fetch;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export type DevicePoll =
  | { status: "pending" | "slowDown" | "expired" | "denied"; intervalSeconds: number }
  | { status: "done"; intervalSeconds: number; accessToken: string; scopes: string[] };

/** Scopes for signing in; repo is added only when the person opts in. */
export function deviceScopes(repoAccess: boolean): string[] {
  return repoAccess ? ["read:user", "user:email", "repo"] : ["read:user", "user:email"];
}

// Tests point the flow at a mock GitHub per database (one panel each).
const overrides = new WeakMap<object, Partial<GithubEndpoints>>();

export function overrideGithubEndpoints(db: PanelDb, endpoints: Partial<GithubEndpoints>): void {
  overrides.set(db, endpoints);
}

export function githubEndpoints(deps: { db: PanelDb; config: Config }): GithubEndpoints {
  // A white-label build or a self-hoster may configure its own OAuth App
  // (SEYLO_GITHUB_CLIENT_ID); the brand's id is the default.
  const configured = deps.config.githubClientId;
  return {
    clientId: configured || oauthClientId,
    loginBase: "https://github.com",
    apiBase: "https://api.github.com",
    fetch: globalThis.fetch,
    ...overrides.get(deps.db),
  };
}

/** False while the client id is still the brand placeholder: hide every GitHub button. */
export function githubAvailable(deps: { db: PanelDb; config: Config }): boolean {
  const { clientId } = githubEndpoints(deps);
  return clientId !== "" && !isPlaceholder(clientId);
}

const unavailable = () => new OpError("UNAVAILABLE", "GitHub sign-in is not configured on this panel.");
const githubDown = () => new OpError("UNAVAILABLE", "GitHub did not answer. Try again in a moment.");

async function postForm(endpoints: GithubEndpoints, path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await endpoints.fetch(`${endpoints.loginBase}${path}`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": slug },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw githubDown();
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (!response.ok && typeof body.error !== "string")) throw githubDown();
  return body;
}

async function getJson(endpoints: GithubEndpoints, token: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await endpoints.fetch(`${endpoints.apiBase}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": slug,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw githubDown();
  }
  if (!response.ok) throw new OpError("UNAVAILABLE", `GitHub refused the request (HTTP ${response.status}).`);
  return response.json();
}

export interface DeviceStart {
  ticket: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}

/** Asks GitHub for a device code and stores it behind a new ticket. */
export async function startDeviceFlow(
  deps: { db: PanelDb; config: Config; secrets: SecretBox },
  purpose: Extract<ChallengePurpose, "githubSignIn" | "githubLink" | "githubSetup" | "githubReauth">,
  options: { userId?: string | null; repoAccess: boolean },
): Promise<DeviceStart> {
  if (!githubAvailable(deps)) throw unavailable();
  const endpoints = githubEndpoints(deps);
  const body = await postForm(endpoints, "/login/device/code", {
    client_id: endpoints.clientId,
    scope: deviceScopes(options.repoAccess).join(" "),
  });
  if (typeof body.error === "string") {
    throw new OpError("UNAVAILABLE", `GitHub refused the device flow: ${String(body.error_description ?? body.error)}`);
  }
  const deviceCode = String(body.device_code ?? "");
  const userCode = String(body.user_code ?? "");
  const verificationUri = String(body.verification_uri ?? "https://github.com/login/device");
  const expiresIn = Number(body.expires_in ?? 900);
  const interval = Math.max(1, Number(body.interval ?? 5));
  if (!deviceCode || !userCode) throw githubDown();

  const { ticket, expiresAt } = createChallenge(deps.db, {
    purpose,
    userId: options.userId ?? null,
    // The first poll also waits one interval, as GitHub asks.
    data: { intervalSeconds: interval, repoAccess: options.repoAccess, lastPollAt: Date.now() },
    secretSealed: deps.secrets.seal(deviceCode, "auth.challenge"),
    ttlMs: expiresIn * 1000,
  });
  return { ticket, userCode, verificationUri, expiresAt: expiresAt.toISOString(), intervalSeconds: interval };
}

/**
 * Polls GitHub once for the challenge's device code. Polls faster than the
 * interval get slowDown without asking GitHub. Expired and denied flows
 * delete the challenge; a done flow leaves it to the caller, which deletes
 * it after using the token.
 */
export async function pollDeviceFlow(
  deps: { db: PanelDb; config: Config; secrets: SecretBox },
  challenge: Challenge,
  now = new Date(),
): Promise<DevicePoll> {
  const endpoints = githubEndpoints(deps);
  const data = challenge.data as { intervalSeconds?: number; lastPollAt?: number };
  const interval = Math.max(1, Number(data.intervalSeconds ?? 5));
  if (now.getTime() - Number(data.lastPollAt ?? 0) < interval * 1000 - 250) {
    return { status: "slowDown", intervalSeconds: interval };
  }
  updateChallengeData(deps.db, challenge, { lastPollAt: now.getTime() });

  const deviceCode = challenge.secretSealed ? deps.secrets.open(challenge.secretSealed, "auth.challenge") : null;
  if (!deviceCode) {
    deleteChallenge(deps.db, challenge.id);
    return { status: "expired", intervalSeconds: interval };
  }
  const body = await postForm(endpoints, "/login/oauth/access_token", {
    client_id: endpoints.clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (typeof body.access_token === "string" && body.access_token !== "") {
    const scopes = String(body.scope ?? "")
      .split(/[,\s]+/)
      .filter(Boolean);
    return { status: "done", intervalSeconds: interval, accessToken: body.access_token, scopes };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending", intervalSeconds: interval };
    case "slow_down": {
      const next = Math.max(interval + 5, Number(body.interval ?? 0));
      updateChallengeData(deps.db, challenge, { intervalSeconds: next, lastPollAt: now.getTime() });
      return { status: "slowDown", intervalSeconds: next };
    }
    case "expired_token":
      deleteChallenge(deps.db, challenge.id);
      return { status: "expired", intervalSeconds: interval };
    case "access_denied":
      deleteChallenge(deps.db, challenge.id);
      return { status: "denied", intervalSeconds: interval };
    default:
      deleteChallenge(deps.db, challenge.id);
      throw new OpError("UNAVAILABLE", `GitHub sign-in failed: ${String(body.error_description ?? body.error ?? "unknown error")}`);
  }
}

export async function githubUser(deps: { db: PanelDb; config: Config }, token: string): Promise<GithubUser> {
  const body = (await getJson(githubEndpoints(deps), token, "/user")) as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof body.id !== "number" || typeof body.login !== "string") throw githubDown();
  return { id: body.id, login: body.login, name: typeof body.name === "string" ? body.name : null };
}

/** The account's primary email if GitHub verified it, else null. */
export async function githubPrimaryEmail(deps: { db: PanelDb; config: Config }, token: string): Promise<string | null> {
  const body = (await getJson(githubEndpoints(deps), token, "/user/emails")) as { email?: string; primary?: boolean; verified?: boolean }[];
  if (!Array.isArray(body)) return null;
  const primary = body.find((e) => e.primary && e.verified && typeof e.email === "string");
  return primary?.email?.toLowerCase() ?? null;
}
