// Bodies read before authentication are capped while reading, and the
// GitHub webhook neither stores unlimited rejected rows nor deploys a
// replayed signed body sent under a new delivery id.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { githubApps, webhookDeliveries } from "../src/db/schema";
import { type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
const secret = "whsec-test";
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("op bodies over the cap are refused before parsing", async () => {
  const big = JSON.stringify({ email: "a@b.c", password: "x".repeat(5 * 1024 * 1024) });
  const res = await panel.app.handle(
    new Request("http://panel.test/api/v1/auth.login", {
      method: "POST",
      headers: { host: "panel.test", "content-type": "application/json" },
      body: big,
    }),
  );
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { message: string } }).error.message).toContain("larger than");
});

test("webhook: rejected rows are capped, a replayed body under a new id is not handled again", async () => {
  panel.deps.db
    .insert(githubApps)
    .values({
      appId: 1,
      slug: "s",
      name: "s",
      htmlUrl: "https://github.com/apps/s",
      ownerLogin: "o",
      clientId: "c",
      clientSecretSealed: panel.deps.secrets.seal("cs", "github.app"),
      privateKeySealed: panel.deps.secrets.seal("not used", "github.app"),
      webhookSecretSealed: panel.deps.secrets.seal(secret, "github.app"),
    })
    .run();
  const post = (body: string, headers: Record<string, string>) =>
    panel.app.handle(
      new Request("http://panel.test/api/hooks/github", { method: "POST", headers: { host: "panel.test", ...headers }, body }),
    );

  for (let i = 0; i < 40; i++)
    await post("{}", { "x-github-delivery": `bad-${i}`, "x-github-event": "push", "x-hub-signature-256": "sha256=00" });
  expect(panel.deps.db.select().from(webhookDeliveries).all().length).toBeLessThanOrEqual(20);

  const body = JSON.stringify({ zen: "x" });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const first = await post(body, { "x-github-delivery": "guid-1", "x-github-event": "meta", "x-hub-signature-256": signature });
  expect(first.status).toBe(200);
  const replay = await post(body, { "x-github-delivery": "guid-2", "x-github-event": "meta", "x-hub-signature-256": signature });
  expect(await replay.json()).toMatchObject({ duplicate: true });
  const noId = await post(body, { "x-github-event": "meta", "x-hub-signature-256": signature });
  expect(noId.status).toBe(400);
});
