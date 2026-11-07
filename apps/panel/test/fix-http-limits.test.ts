// Bodies read before authentication are capped while reading, and the
// GitHub webhook neither stores unlimited rejected rows nor deploys a
// replayed signed body sent under a new delivery id.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import { bodyBudget, bufferedBodyBytes } from "@seylo/ops/elysia";
import { githubApps, webhookDeliveries } from "../src/db/schema";
import { createProxyTrust } from "../src/http/proxy-trust";
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

const post = (path: string, body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  panel.app.handle(
    new Request(`http://panel.test${path}`, {
      method: "POST",
      headers: { host: "panel.test", "content-type": "application/json", ...headers },
      body,
    }),
  );

test("most ops take 1 MiB before authentication; the few with large inputs take more", async () => {
  const body = JSON.stringify({ name: "x".repeat(1536 * 1024) });
  const small = await post("/api/v1/projects.create", body);
  expect(small.status).toBe(400);
  expect(((await small.json()) as { error: { message: string } }).error.message).toContain("larger than 1 MiB");
  // files.write reads it (and then wants a sign-in).
  const large = await post("/api/v1/files.write", JSON.stringify({ content: "x".repeat(1536 * 1024) }));
  expect(large.status).toBe(401);
});

test("bodies being read at once share one budget; past it a read is refused as busy", async () => {
  const saved = bodyBudget.maxBytes;
  bodyBudget.maxBytes = 100_000;
  try {
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
      },
    });
    if (!push) throw new Error("the stream did not start");
    push.enqueue(new Uint8Array(80_000).fill(0x20));
    const pending = post("/api/v1/auth.login", slow);
    await Bun.sleep(20);
    expect(bufferedBodyBytes()).toBe(80_000);
    const refused = await post("/api/v1/auth.login", " ".repeat(50_000));
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    push.close();
    await pending;
    expect(bufferedBodyBytes()).toBe(0);
    expect((await post("/api/v1/auth.login", " ".repeat(50_000))).status).not.toBe(503);
  } finally {
    bodyBudget.maxBytes = saved;
  }
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

function insertGithubApp() {
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
}

const signedDelivery = (n: number, event = "meta") => {
  const body = JSON.stringify({ zen: `delivery ${n}` });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return post("/api/hooks/github", body, { "x-github-delivery": `ok-${n}`, "x-github-event": event, "x-hub-signature-256": signature });
};
const badDelivery = (n: number) =>
  post("/api/hooks/github", "{}", { "x-github-delivery": `bad-${n}`, "x-github-event": "push", "x-hub-signature-256": "sha256=00" });

test("webhook: signed deliveries from one address never use its budget up; only refused ones count", async () => {
  insertGithubApp();
  // No refill while the test runs: every token is accounted for.
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  try {
    // A busy organisation: GitHub sends them all from one address. Before: 429 from the 61st on, and GitHub does not retry.
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push((await signedDelivery(i)).status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // Refused deliveries keep their token: 60, then 429 before the body is read, signed or not.
    const refused: number[] = [];
    for (let i = 0; i < 61; i++) refused.push((await badDelivery(i)).status);
    expect(refused.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(refused[60]).toBe(429);
    expect((await signedDelivery(300)).status).toBe(429);
    // A second later one token is back, and a signed delivery returns the one it took.
    setSystemTime(new Date("2026-11-07T12:00:01Z"));
    expect((await signedDelivery(301)).status).toBe(200);
    expect((await signedDelivery(302)).status).toBe(200);
    expect((await badDelivery(61)).status).toBe(401);
    expect((await badDelivery(62)).status).toBe(429);
  } finally {
    setSystemTime();
  }
});

test("webhook: a signed delivery posted again under its own id, and pings, keep their token", async () => {
  insertGithubApp();
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  try {
    // A captured delivery posted in a loop: the first is new and gives its token back, every repeat keeps one.
    const again: number[] = [];
    for (let i = 0; i < 61; i++) again.push((await signedDelivery(0)).status);
    expect(again.filter((s) => s !== 200)).toEqual([]);
    expect((await signedDelivery(0)).status).toBe(429);
    // A second later one token is back; new deliveries still pass and return it.
    setSystemTime(new Date("2026-11-07T12:00:01Z"));
    expect((await signedDelivery(1)).status).toBe(200);
    expect((await signedDelivery(2)).status).toBe(200);
    // Pings are not remembered, so each one keeps its token.
    expect((await signedDelivery(3, "ping")).status).toBe(200);
    expect((await signedDelivery(4, "ping")).status).toBe(429);
  } finally {
    setSystemTime();
  }
});

test("webhook: deliveries from GitHub's own addresses are always read, so anyone's refused ones never block the App's", async () => {
  // Behind the panel's proxy, which names the sender in X-Forwarded-For.
  panel.close();
  panel = testPanel({ proxy: createProxyTrust({ always: true, proxies: [] }) });
  insertGithubApp();
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  try {
    const from = (address: string) => ({ "x-forwarded-for": address });
    const hook = {
      "x-github-hook-id": "123",
      "x-github-hook-installation-target-type": "repository",
      "x-github-hook-installation-target-id": "456",
    };
    const unsigned = (n: number, address: string) =>
      post("/api/hooks/github", "{}", {
        ...from(address),
        ...hook,
        "x-github-delivery": `attacker-${address}-${n}`,
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=00",
      });
    const signed = (n: number, address: string) => {
      const body = JSON.stringify({ zen: `delivery ${n}` });
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return post("/api/hooks/github", body, {
        ...from(address),
        "x-github-delivery": `ok-${n}`,
        "x-github-event": "meta",
        "x-hub-signature-256": signature,
      });
    };
    // Someone's own repository webhook with the wrong secret, delivered from GitHub's address (IPv4 and IPv6 ranges).
    // Before: 429 from the 61st on, and the App's next delivery from there was refused unread.
    for (const [n, address] of ["140.82.115.10", "2606:50c0:8000::153"].entries()) {
      const statuses: number[] = [];
      for (let i = 0; i < 1000; i++) statuses.push((await unsigned(i, address)).status);
      expect(statuses.filter((s) => s !== 401)).toEqual([]);
      expect((await signed(n, address)).status).toBe(200);
    }
    // The refused rows name the webhook that sent them.
    const rejected = panel.deps.db.select().from(webhookDeliveries).all();
    expect(rejected[0]?.detail).toBe("The signature did not match (GitHub hook 123 on repository 456).");
    // Any other address still gets 60 refused deliveries, then 429 before the body is read.
    const other: number[] = [];
    for (let i = 0; i < 61; i++) other.push((await unsigned(i, "203.0.113.5")).status);
    expect(other.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(other[60]).toBe(429);
    // A forged GitHub address in a header the proxy did not write is not believed.
    expect((await unsigned(61, "140.82.115.10, 203.0.113.5")).status).toBe(429);
  } finally {
    setSystemTime();
  }
});

test("webhook: a body refused because the panel is busy does not count against the sender", async () => {
  insertGithubApp();
  const saved = bodyBudget.maxBytes;
  bodyBudget.maxBytes = 1000;
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  try {
    for (let i = 0; i < 80; i++) {
      const res = await post("/api/hooks/github", " ".repeat(2000), { "x-github-delivery": `busy-${i}`, "x-github-event": "push" });
      expect(res.status).toBe(503);
    }
    bodyBudget.maxBytes = saved;
    expect((await badDelivery(0)).status).toBe(401);
  } finally {
    bodyBudget.maxBytes = saved;
    setSystemTime();
  }
});

test("webhook: one sender gets 60 deliveries, then 429 before the body is read", async () => {
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
  const statuses: number[] = [];
  for (let i = 0; i < 61; i++) {
    const res = await post("/api/hooks/github", "{}", {
      "x-github-delivery": `d-${i}`,
      "x-github-event": "push",
      "x-hub-signature-256": "sha256=00",
    });
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
  expect(statuses[60]).toBe(429);
});
