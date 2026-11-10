// Avatars: the signed-in person's generated face or uploaded image, the
// routes that serve them, and a random face for every account that has
// none when the panel starts (accounts from before avatars).
// Contracts: packages/ops/src/ops/avatars.ts; the style catalog is
// packages/ops/src/avatars.ts.

import { avatars as avatarOps, OpError } from "@seylo/ops";
import { assignMissingAvatars } from "../../auth/avatar";
import { requireSession } from "../../auth/sign-in";
import { implement, type OpContext } from "../../ops/implement";
import { defineModule } from "../module";
import { avatarRoutes } from "./http";
import { ensureAvatar, parseAvatarUpload, removeUpload, saveUpload, setPreset, toAvatar } from "./store";

/** Lists and the sidebar show avatars: they refetch after a change. */
function changed(ctx: OpContext) {
  ctx.live.publish("panel", { type: "invalidate", ops: ["auth.whoami", "users.list", "users.get", "grants.listByProject"] });
}

const mine = implement(avatarOps.mine, (_input, ctx) => {
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  const userId = ctx.principal.user.id;
  return { avatar: toAvatar(userId, ensureAvatar(ctx.db, userId)) };
});

const setPresetOp = implement(avatarOps.setPreset, (input, ctx) => {
  const { userId } = requireSession(ctx);
  const avatar = setPreset(ctx.db, userId, input.style, input.seed);
  changed(ctx);
  return { avatar: toAvatar(userId, avatar) };
});

const upload = implement(avatarOps.upload, (input, ctx) => {
  const { userId } = requireSession(ctx);
  const avatar = saveUpload(ctx.db, userId, parseAvatarUpload(input.dataUrl));
  changed(ctx);
  return { avatar: toAvatar(userId, avatar) };
});

const removeUploadOp = implement(avatarOps.removeUpload, (_input, ctx) => {
  const { userId } = requireSession(ctx);
  const avatar = removeUpload(ctx.db, userId);
  changed(ctx);
  return { avatar: toAvatar(userId, avatar) };
});

export default defineModule({
  name: "avatars",
  ops: [mine, setPresetOp, upload, removeUploadOp],
  http: avatarRoutes,
  start: (deps) => {
    assignMissingAvatars(deps.db);
  },
});
