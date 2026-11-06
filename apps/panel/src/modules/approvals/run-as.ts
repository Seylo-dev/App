// Runs an op through the normal pipeline as a given person, for callers
// that act for someone without holding their credentials: the AI
// assistant (the person who chats) and approvals (the person who
// approved). The pipeline takes the principal directly (OpCall.principal);
// a disabled or removed person gets UNAUTHENTICATED, as their session would.

import { type AnyOpContract, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { users } from "../../db/schema";
import type { Deps } from "../../deps";
import type { OpOutcome } from "../../ops/pipeline";

export interface RunAsCall {
  op: AnyOpContract;
  input: unknown;
  userId: string;
  transport: "mcp" | "ai";
  approvalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function runOpAs(deps: Pick<Deps, "db" | "ops">, call: RunAsCall): Promise<OpOutcome> {
  const row = deps.db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, call.userId))
    .get();
  if (!row || row.disabledAt) return { ok: false, error: new OpError("UNAUTHENTICATED", "This person can no longer sign in.") };
  const { disabledAt: _, ...user } = row;
  const principal: Principal = { type: "session", user, sessionId: call.transport === "ai" ? "assistant" : "approval" };
  return deps.ops.execute({
    op: call.op,
    rawInput: call.input,
    credentials: {},
    principal,
    transport: call.transport,
    coerce: false,
    ip: call.ip ?? null,
    userAgent: call.userAgent ?? null,
    http: null,
    approvalId: call.approvalId ?? null,
  });
}
