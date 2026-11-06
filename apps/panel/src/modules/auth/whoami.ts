import { auth, OpError } from "@seylo/ops";
import { toViewer } from "../../auth/sign-in";
import { implement } from "../../ops/implement";

export const whoami = implement(auth.whoami, (_input, ctx) => {
  // The pipeline only runs signed-in ops for signed-in principals.
  if (ctx.principal.type === "anonymous") throw new OpError("UNAUTHENTICATED", "Sign in first.");
  return { viewer: toViewer(ctx.principal.user), via: ctx.principal.type };
});
