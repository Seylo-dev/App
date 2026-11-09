// Creating the owner from the setup link, with a password or with GitHub.

import { OpError, setup } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deleteChallenge, findChallenge } from "../../auth/challenges";
import { saveGithubAccount } from "../../auth/github-accounts";
import { githubPrimaryEmail, githubUser, pollDeviceFlow } from "../../auth/github-device";
import { burnSetupToken, ownerExists, removeSetupTokenFile, validSetupToken } from "../../auth/setup-token";
import { startSession, toViewer } from "../../auth/sign-in";
import type { PanelDb } from "../../db/client";
import { users } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { hashPassword } from "../../security/password";
import { rememberSetupHost } from "../nodes/address";
import { applySetupChoice } from "../telemetry";

/** Throws unless the link can still create the owner; returns the token row. */
export function requireUsableLink(db: PanelDb, token: string) {
  if (ownerExists(db)) throw new OpError("CONFLICT", "The owner account already exists. Sign in instead.");
  const row = validSetupToken(db, token);
  if (!row)
    throw new OpError("FORBIDDEN", "This setup link was used or has expired. Run the installer's setup-link command for a new one.");
  return row;
}

function insertOwner(ctx: OpContext, token: string, values: { email: string; name: string; passwordHash: string | null }) {
  const owner = ctx.db.transaction((tx) => {
    // Checked again inside the transaction: two tabs racing on one link
    // must not both create an owner.
    const link = requireUsableLink(tx as unknown as PanelDb, token);
    if (tx.select({ id: users.id }).from(users).where(eq(users.email, values.email)).get()) {
      throw new OpError("CONFLICT", "An account with this email already exists.");
    }
    burnSetupToken(tx as unknown as PanelDb, link.id);
    return tx
      .insert(users)
      .values({ ...values, role: "owner" })
      .returning()
      .get();
  });
  removeSetupTokenFile(ctx.config.dataDir);
  // Where the owner reached the panel is how people reach the panel node (1:1 NAT clouds hide it).
  rememberSetupHost(ctx.db, ctx.origin);
  // The owner's email is every node's ACME contact, and Traefik is
  // recreated when it changes. Send it now, while nothing is routed yet,
  // rather than with whatever full sync comes next (setting the panel
  // domain, for one, would recreate Traefik just as its certificate is asked for).
  ctx.agents.desired.markDirty({ all: true });
  return owner;
}

export const createOwner = implement(setup.createOwner, async (input, ctx) => {
  if (!ctx.http) throw new OpError("BAD_REQUEST", "Setup is only available in the browser.");
  requireUsableLink(ctx.db, input.token);
  const passwordHash = await hashPassword(input.password);
  const owner = insertOwner(ctx, input.token, {
    email: input.email.trim().toLowerCase(),
    name: input.name?.trim() ?? "",
    passwordHash,
  });
  applySetupChoice(ctx, input.telemetry);
  startSession(ctx, owner.id);
  return { viewer: toViewer(owner) };
});

export const githubPoll = implement(setup.githubPoll, async (input, ctx) => {
  if (!ctx.http) throw new OpError("BAD_REQUEST", "Setup is only available in the browser.");
  requireUsableLink(ctx.db, input.token);
  const challenge = findChallenge(ctx.db, input.ticket, "githubSetup");
  if (!challenge) throw new OpError("BAD_REQUEST", "This GitHub sign-up expired. Start again.");
  const poll = await pollDeviceFlow(ctx, challenge);
  if (poll.status !== "done") return { status: poll.status, intervalSeconds: poll.intervalSeconds };

  deleteChallenge(ctx.db, challenge.id);
  const github = await githubUser(ctx, poll.accessToken);
  const email = await githubPrimaryEmail(ctx, poll.accessToken);
  if (!email) {
    throw new OpError("BAD_REQUEST", "Your GitHub account has no verified primary email. Verify one on GitHub or use email and password.");
  }
  const owner = insertOwner(ctx, input.token, { email, name: (github.name ?? github.login).slice(0, 80), passwordHash: null });
  saveGithubAccount(ctx.db, ctx.secrets, owner.id, github, poll.accessToken, poll.scopes);
  applySetupChoice(ctx, input.telemetry);
  startSession(ctx, owner.id);
  return { status: "done" as const, intervalSeconds: poll.intervalSeconds, viewer: toViewer(owner) };
});
