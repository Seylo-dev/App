// Edge tickets: short-lived, single-use grants the panel signs and the
// node's edge listener verifies locally with the public key it got in
// HelloAccepted (no round trip to the panel). They open database web UIs
// and Boxes. Format (shared with go/internal/edge, see CONTRACTS.md):
//
//   token     = <payload>.<signature>                       both base64url, no padding
//   payload   = base64url(JSON {"v":1,"sub","uid","exp","jti"})   exp in Unix seconds
//   signature = Ed25519("<slug>-edge-ticket-v1" 0x00 <payload string>)

import { createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { slug } from "@seylo/brand";
import { boxes as boxOps, databases as dbOps, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { createAccess } from "../../auth/access";
import type { Principal } from "../../auth/principal";
import { apiKeys, serviceBoxes, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { ensureEdgeTicketKey } from "../../security/edge-ticket-key";
import { findDatabase } from "./info";

export const edgeTicketContext = `${slug}-edge-ticket-v1`;
export const edgeTicketTtlSeconds = 60;

export type EdgeTool = "db" | "box";

export interface EdgeTicketClaims {
  v: 1;
  /** "db-ui:<serviceId>" or "box:<serviceId>". */
  sub: string;
  uid: string;
  exp: number;
  jti: string;
}

const subjectPrefix: Record<EdgeTool, string> = { db: "db-ui", box: "box" };

export function edgeSubject(tool: EdgeTool, serviceId: string): string {
  return `${subjectPrefix[tool]}:${serviceId}`;
}

function signedBytes(payload: string): Buffer {
  return Buffer.concat([Buffer.from(edgeTicketContext, "ascii"), Buffer.from([0]), Buffer.from(payload, "ascii")]);
}

export function signEdgeTicket(
  deps: Pick<Deps, "db" | "secrets">,
  claims: { sub: string; uid: string },
  now = Date.now(),
): { token: string; expiresAt: Date } {
  const key = ensureEdgeTicketKey(deps.db, deps.secrets);
  const exp = Math.floor(now / 1000) + edgeTicketTtlSeconds;
  const body: EdgeTicketClaims = { v: 1, sub: claims.sub, uid: claims.uid, exp, jti: randomBytes(12).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = sign(null, signedBytes(payload), key.privateKey).toString("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date(exp * 1000) };
}

/** What the edge does with a token; here for tests and as the reference for the Go side. */
export function verifyEdgeTicket(publicKey: Uint8Array, token: string, wantSubject: string, now = Date.now()): EdgeTicketClaims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") }, format: "jwk" });
  if (!verify(null, signedBytes(payload), key, Buffer.from(signature, "base64url"))) return null;
  let claims: EdgeTicketClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.v !== 1 || claims.sub !== wantSubject || claims.exp * 1000 + 30_000 < now) return null;
  return claims;
}

/** Host the node's edge serves a tool on, under the node's wildcard domain. */
export function edgeToolHost(tool: EdgeTool, serviceId: string, wildcardDomain: string): string {
  return `${slug}-${tool}-${serviceId}.${wildcardDomain}`;
}

/**
 * One-time sign-in link to a tool on a node; CONFLICT when the node has no
 * wildcard domain. The ticket's uid names who opened it so the node can
 * ask again later (CheckEdgeAccess, edgeAccessAllowed): the user's id for
 * a browser session, "key:<id>" for an API key, whose narrower rights are
 * what is checked again.
 */
export function edgeToolLink(
  deps: Pick<Deps, "db" | "secrets">,
  tool: EdgeTool,
  serviceId: string,
  node: { name: string; wildcardDomain: string | null },
  principal: Principal,
): { url: string; expiresAt: Date } {
  if (principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in or use a valid API key.");
  const userId = principal.type === "apiKey" ? `${keyUidPrefix}${principal.keyId}` : principal.user.id;
  if (!node.wildcardDomain) {
    throw new OpError(
      "CONFLICT",
      `Node ${node.name} has no wildcard domain. Set one on the node (a *.domain A record pointing at it) to open tools in the browser.`,
      { reason: "noWildcardDomain", nodeName: node.name },
    );
  }
  const { token, expiresAt } = signEdgeTicket(deps, { sub: edgeSubject(tool, serviceId), uid: userId });
  const host = edgeToolHost(tool, serviceId, node.wildcardDomain);
  return { url: `https://${host}/_${slug}/ticket?t=${encodeURIComponent(token)}`, expiresAt };
}

/** The op whose rights a tool needs: opening it and every later check use the same contract. */
const toolOps = { box: boxOps.open, db: dbOps.openWebUi } as const;

/** Whether `principal` may still open `tool` on the service: the op's permission, and the service is that kind of tool. */
export function mayOpenEdgeTool(db: Deps["db"], principal: Principal, tool: EdgeTool, serviceId: string): boolean {
  const op = toolOps[tool];
  try {
    createAccess(db, principal).require(op.permission, op.kind, { serviceId });
  } catch {
    return false;
  }
  if (tool === "db") return findDatabase(db, serviceId) !== undefined;
  return db.select({ id: serviceBoxes.serviceId }).from(serviceBoxes).where(eq(serviceBoxes.serviceId, serviceId)).get() !== undefined;
}

/** Ticket uid prefix of an API key: "key:<api key id>". */
const keyUidPrefix = "key:";

/**
 * Who a ticket's uid names, as of now: null when the user is gone or
 * disabled, or the API key was revoked or expired (the same conditions
 * as signing in with them).
 */
function principalOfUid(db: Deps["db"], uid: string, now: Date): Principal | null {
  const keyId = uid.startsWith(keyUidPrefix) ? uid.slice(keyUidPrefix.length) : null;
  const userId = keyId ? db.select({ userId: apiKeys.userId }).from(apiKeys).where(eq(apiKeys.id, keyId)).get()?.userId : uid;
  if (!userId) return null;
  const user = db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user || user.disabledAt) return null;
  const { disabledAt: _, ...person } = user;
  if (!keyId) return { type: "session", user: person, sessionId: "" };
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return null;
  return {
    type: "apiKey",
    user: person,
    keyId: key.id,
    keyName: key.name,
    keyKind: key.kind,
    actions: key.actions,
    projectIds: key.projectIds ?? null,
    readOnly: key.readOnly,
  };
}

/**
 * PanelService.CheckEdgeAccess: whether whoever a node's edge opened a tool
 * session for (ticket subject "box:<id>" or "db-ui:<id>", uid) may keep it.
 * False when the subject is unknown, the service does not run on the asking
 * node, the user is gone or disabled (or the API key revoked or expired), or
 * no longer has the tool's right.
 */
export function edgeAccessAllowed(
  deps: Pick<Deps, "db" | "agents">,
  nodeId: string,
  input: { subject: string; userId: string },
  now = new Date(),
): boolean {
  const match = /^(box|db-ui):([A-Za-z0-9_-]{1,64})$/.exec(input.subject);
  if (!match || !input.userId) return false;
  const tool: EdgeTool = match[1] === "box" ? "box" : "db";
  const serviceId = match[2] as string;
  if (!deps.agents.runsService(nodeId, serviceId)) return false;
  const principal = principalOfUid(deps.db, input.userId, now);
  return principal !== null && mayOpenEdgeTool(deps.db, principal, tool, serviceId);
}
