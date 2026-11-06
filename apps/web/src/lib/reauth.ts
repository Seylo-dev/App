// Fresh sign-in before changes that add a way into the account. The panel
// refuses such ops with `details.reason = "reauth"` when
// the session's last sign-in or re-auth is too old. This wraps the op client
// so that refusal opens the re-auth dialog (components/auth/reauth-dialog.tsx)
// and the same call runs once more after the person confirmed it is them.
// Screens need nothing per op: any mutation the panel guards gets it.

import { type AnyOpContract, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";

/** Shows the dialog; resolves true once the re-auth went through, false when the person closed it. */
export type ReauthPrompt = (message: string) => Promise<boolean>;

let prompt: ReauthPrompt | null = null;
let open: Promise<boolean> | null = null;

/** The dialog host registers itself here; returns the unregister function. */
export function setReauthPrompt(next: ReauthPrompt): () => void {
  prompt = next;
  return () => {
    if (prompt === next) prompt = null;
  };
}

export function isReauthError(error: unknown): error is OpError {
  return error instanceof OpError && error.details?.reason === "reauth";
}

/** The person closed the re-auth dialog: the screen should stay quiet, nothing failed. */
export function isReauthCancelled(error: unknown): boolean {
  return isReauthError(error) && error.details?.cancelled === "true";
}

/** Ops the dialog itself calls; a refusal from them never opens another dialog. */
function isReauthOp(op: Pick<AnyOpContract, "id">): boolean {
  return op.id.startsWith("auth.reauth");
}

// Calls refused at the same time share one dialog.
function ask(message: string): Promise<boolean> {
  if (!prompt) return Promise.resolve(false);
  if (!open) {
    open = prompt(message).finally(() => {
      open = null;
    });
  }
  return open;
}

export function withReauth(client: OpClient): OpClient {
  return {
    async call(op, input, init) {
      try {
        return await client.call(op, input, init);
      } catch (error) {
        if (op.kind === "query" || isReauthOp(op) || !isReauthError(error) || !prompt) throw error;
        if (!(await ask(error.message))) throw new OpError(error.code, error.message, { ...error.details, cancelled: "true" });
        // Once: a second refusal right after a re-auth is a real answer, not a reason to ask again.
        return client.call(op, input, init);
      }
    },
  };
}
