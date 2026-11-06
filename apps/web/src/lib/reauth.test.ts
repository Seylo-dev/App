import { afterEach, describe, expect, test } from "bun:test";
import { type AnyOpContract, apiKeys, auth, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { isReauthCancelled, isReauthError, setReauthPrompt, withReauth } from "./reauth";

const refused = () => new OpError("FORBIDDEN", "Confirm it is you first.", { reason: "reauth" });

/** A client that fails the first `failures` calls with `error`, then answers ok. */
function fakeClient(failures: number, error: () => OpError = refused) {
  const calls: string[] = [];
  const client: OpClient = {
    async call(op: AnyOpContract) {
      calls.push(op.id);
      if (calls.length <= failures) throw error();
      return { ok: true } as never;
    },
  };
  return { client, calls };
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe("withReauth", () => {
  test("a refused mutation asks once, then runs again", async () => {
    const { client, calls } = fakeClient(1);
    const asked: string[] = [];
    unregister = setReauthPrompt(async (message) => {
      asked.push(message);
      return true;
    });
    await expect(withReauth(client).call(apiKeys.create, { name: "ci", actions: ["*"] } as never)).resolves.toEqual({ ok: true } as never);
    expect(asked).toEqual(["Confirm it is you first."]);
    expect(calls).toEqual(["apiKeys.create", "apiKeys.create"]);
  });

  test("closing the dialog fails the call quietly", async () => {
    const { client, calls } = fakeClient(1);
    unregister = setReauthPrompt(async () => false);
    const error = await withReauth(client)
      .call(auth.totpEnroll, {})
      .catch((e: unknown) => e);
    expect(isReauthError(error)).toBe(true);
    expect(isReauthCancelled(error)).toBe(true);
    expect(calls).toEqual(["auth.totpEnroll"]);
  });

  test("a second refusal after the re-auth is passed on, not asked again", async () => {
    const { client, calls } = fakeClient(2);
    let asked = 0;
    unregister = setReauthPrompt(async () => {
      asked++;
      return true;
    });
    const error = await withReauth(client)
      .call(auth.totpEnroll, {})
      .catch((e: unknown) => e);
    expect(isReauthError(error)).toBe(true);
    expect(isReauthCancelled(error)).toBe(false);
    expect(asked).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("queries, other errors and no dialog host pass the error through", async () => {
    unregister = setReauthPrompt(async () => {
      throw new Error("must not ask");
    });
    const query = fakeClient(1);
    await expect(withReauth(query.client).call(auth.security, {})).rejects.toThrow("Confirm it is you first.");
    // The dialog's own ops answer for themselves.
    const own = fakeClient(1);
    await expect(withReauth(own.client).call(auth.reauthPasskeyBegin, {})).rejects.toThrow("Confirm it is you first.");
    const other = fakeClient(1, () => new OpError("BAD_REQUEST", "Name is taken."));
    await expect(withReauth(other.client).call(auth.totpEnroll, {})).rejects.toThrow("Name is taken.");
    unregister();
    unregister = null;
    const noHost = fakeClient(1);
    const error = await withReauth(noHost.client)
      .call(auth.totpEnroll, {})
      .catch((e: unknown) => e);
    expect(isReauthCancelled(error)).toBe(false);
  });

  test("calls refused together share one dialog", async () => {
    const first = fakeClient(1);
    const second = fakeClient(1);
    let asked = 0;
    let confirm: (ok: boolean) => void = () => {};
    unregister = setReauthPrompt(() => {
      asked++;
      return new Promise((resolve) => {
        confirm = resolve;
      });
    });
    const a = withReauth(first.client).call(auth.totpEnroll, {});
    const b = withReauth(second.client).call(auth.githubLinkStart, { repoAccess: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    confirm(true);
    await Promise.all([a, b]);
    expect(asked).toBe(1);
    expect(first.calls).toHaveLength(2);
    expect(second.calls).toHaveLength(2);
  });
});
