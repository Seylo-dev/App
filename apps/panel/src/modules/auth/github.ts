// Signing in with GitHub (device flow) and linking or unlinking a GitHub
// login on your own account.

import { auth, OpError } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { deleteChallenge, findChallenge } from "../../auth/challenges";
import { requireFreshSignIn } from "../../auth/fresh";
import { githubAccountFor, saveGithubAccount } from "../../auth/github-accounts";
import { githubUser, pollDeviceFlow, startDeviceFlow } from "../../auth/github-device";
import { finishSignIn, requireSession } from "../../auth/sign-in";
import { githubAccounts, passkeys, users } from "../../db/schema";
import { implement } from "../../ops/implement";
import { raiseSecurityChange } from "../alerts/security";

const expired = () => new OpError("BAD_REQUEST", "This GitHub sign-in expired. Start again.");

export const githubStart = implement(auth.githubStart, (_input, ctx) => startDeviceFlow(ctx, "githubSignIn", { repoAccess: false }));

export const githubPoll = implement(auth.githubPoll, async (input, ctx) => {
  const challenge = findChallenge(ctx.db, input.ticket, "githubSignIn");
  if (!challenge) throw expired();
  const poll = await pollDeviceFlow(ctx, challenge);
  if (poll.status !== "done") return { status: poll.status, intervalSeconds: poll.intervalSeconds };

  deleteChallenge(ctx.db, challenge.id);
  const github = await githubUser(ctx, poll.accessToken);
  const account = githubAccountFor(ctx.db, github.id);
  const user = account ? ctx.db.select().from(users).where(eq(users.id, account.userId)).get() : undefined;
  if (!account || !user) return { status: "noAccount" as const, intervalSeconds: poll.intervalSeconds };
  if (user.disabledAt) throw new OpError("FORBIDDEN", "This account is disabled.");
  saveGithubAccount(ctx.db, ctx.secrets, user.id, github, poll.accessToken, poll.scopes, { keepBroaderToken: true });
  return { status: "done" as const, intervalSeconds: poll.intervalSeconds, result: finishSignIn(ctx, user) };
});

export const githubLinkStart = implement(auth.githubLinkStart, (input, ctx) => {
  // A linked GitHub login is a new way in: only right after a sign-in or a re-auth.
  const { userId } = requireFreshSignIn(ctx);
  return startDeviceFlow(ctx, "githubLink", { userId, repoAccess: input.repoAccess });
});

export const githubLinkPoll = implement(auth.githubLinkPoll, async (input, ctx) => {
  const { userId, user } = requireSession(ctx);
  const challenge = findChallenge(ctx.db, input.ticket, "githubLink");
  if (!challenge || challenge.userId !== userId) throw expired();
  const poll = await pollDeviceFlow(ctx, challenge);
  if (poll.status !== "done") return { status: poll.status, intervalSeconds: poll.intervalSeconds };

  deleteChallenge(ctx.db, challenge.id);
  const github = await githubUser(ctx, poll.accessToken);
  const owner = githubAccountFor(ctx.db, github.id);
  if (owner && owner.userId !== userId) {
    throw new OpError("CONFLICT", `The GitHub login ${github.login} is already linked to another account.`);
  }
  saveGithubAccount(ctx.db, ctx.secrets, userId, github, poll.accessToken, poll.scopes);
  if (!owner) raiseSecurityChange(ctx, user, `linked the GitHub login ${github.login} for sign-in`);
  return { status: "done" as const, intervalSeconds: poll.intervalSeconds, login: github.login };
});

export const githubUnlink = implement(auth.githubUnlink, (_input, ctx) => {
  const { userId } = requireSession(ctx);
  const account = ctx.db.select({ id: githubAccounts.id }).from(githubAccounts).where(eq(githubAccounts.userId, userId)).get();
  if (!account) throw new OpError("NOT_FOUND", "No GitHub login is linked.");
  const user = ctx.db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
  const hasPasskey = ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).get();
  if (!user?.passwordHash && !hasPasskey) {
    throw new OpError("CONFLICT", "GitHub is your only way to sign in. Set a password or add a passkey first.");
  }
  ctx.db.delete(githubAccounts).where(eq(githubAccounts.id, account.id)).run();
  return {};
});
