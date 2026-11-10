// Avatars: a random face for every new account (setup with a password or
// with GitHub, an invite accepted under People, accounts from before
// avatars when the panel starts), picking a face, uploading and removing
// an image, the routes that serve them, and the styles' licenses.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, auth, avatarMaxBytes, avatarStyles, avatars, invites as inviteOps, setup, users as userOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { issueSetupToken } from "../src/auth/setup-token";
import { userAvatars, users } from "../src/db/schema";
import { dicebearStyles } from "../src/modules/avatars/render";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, cookieFrom, mockGithub, noLimits, ok, waitForPoll } from "./people-helpers";

/** A face new accounts get: the default style with a random 10-character seed. */
const newFace = /^\/api\/avatars\/notionists\/[a-z0-9]{10}\.svg$/;

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;

let panel: TestPanel;
let dataDir: string;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
  dataDir = mkdtempSync(join(tmpdir(), "seylo-avatars-"));
  // Owner creation removes the setup token file from the data dir.
  (panel.deps.config as { dataDir: string }).dataDir = dataDir;
});
afterEach(() => {
  panel.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}) {
  return panel.app.handle(new Request(`http://panel.test${path}`, { headers: { host: "panel.test", ...headers } }));
}

function storedAvatar(email: string) {
  return panel.deps.db.select({ avatar: users.avatar }).from(users).where(eq(users.email, email)).get()?.avatar;
}

test("the first owner gets a random face at setup with a password, and keeps it", async () => {
  const { token } = issueSetupToken(panel.deps.db);
  const created = await ok(panel, setup.createOwner, { token, email: "owner@example.com", password: "a long enough password" });
  const stored = storedAvatar("owner@example.com");
  expect(stored).toMatchObject({ kind: "preset", style: "notionists" });
  expect(created.body.viewer.avatarUrl).toMatch(newFace);
  expect(created.body.viewer.avatarUrl).toBe(`/api/avatars/notionists/${stored?.seed}.svg`);
  const cookie = cookieFrom(created.headers) as string;
  expect((await ok(panel, auth.whoami, {}, { cookie })).body.viewer.avatarUrl).toBe(created.body.viewer.avatarUrl);
});

test("the first owner gets a random face when signing up with GitHub", async () => {
  mockGithub(panel, { pollAnswers: [{ access_token: "gho_owner", scope: "read:user,user:email" }] });
  const { token } = issueSetupToken(panel.deps.db);
  const start = await ok(panel, setup.githubStart, { token, repoAccess: false });
  await waitForPoll();
  const done = await ok(panel, setup.githubPoll, { token, ticket: start.body.ticket });
  expect(done.body.status).toBe("done");
  expect(done.body.viewer?.avatarUrl).toMatch(newFace);
  expect(storedAvatar("octo@example.com")).toMatchObject({ kind: "preset", style: "notionists" });
});

test("someone invited under People gets a random face when the invite creates the account", async () => {
  const owner = await createUser(panel, "owner");
  const created = await ok(panel, inviteOps.create, { email: "new@example.com", role: "admin" }, { cookie: owner.cookie });
  const token = new URL(created.body.link, "http://x").searchParams.get("t") as string;
  const accepted = await ok(panel, inviteOps.accept, { token, name: "New", password: "a long enough password" });
  expect(accepted.body.viewer.avatarUrl).toMatch(newFace);
  const stored = storedAvatar("new@example.com");
  expect(stored).toMatchObject({ kind: "preset", style: "notionists" });

  // People lists show it.
  const list = await ok(panel, userOps.list, {}, { cookie: owner.cookie });
  expect(list.body.users.find((u: { email: string }) => u.email === "new@example.com")?.avatarUrl).toBe(
    `/api/avatars/notionists/${stored?.seed}.svg`,
  );
});

test("accounts from before avatars get a face once, when the panel starts", async () => {
  const path = join(dataDir, "panel.db");
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const first = testPanel({ panelPath: path, masterKey });
  const { user } = await createUser(first, "member", "old@example.com");
  expect(first.deps.db.select({ avatar: users.avatar }).from(users).where(eq(users.id, user.id)).get()?.avatar).toBeNull();
  first.close();

  const second = testPanel({ panelPath: path, masterKey });
  const assigned = second.deps.db.select({ avatar: users.avatar }).from(users).where(eq(users.id, user.id)).get()?.avatar;
  expect(assigned).toMatchObject({ kind: "preset", style: "notionists" });
  second.close();

  // Saved, not drawn again on the next start.
  const third = testPanel({ panelPath: path, masterKey });
  expect(third.deps.db.select({ avatar: users.avatar }).from(users).where(eq(users.id, user.id)).get()?.avatar).toEqual(
    assigned as NonNullable<typeof assigned>,
  );
  third.close();
});

test("pick a face, upload an image over it, remove the upload; API keys cannot", async () => {
  const owner = await createUser(panel, "owner");
  const cookie = owner.cookie;
  // An account without an avatar gets one when it first asks.
  const first = await ok(panel, avatars.mine, {}, { cookie });
  expect(first.body.avatar).toMatchObject({ kind: "preset", style: "notionists" });
  expect(first.body.avatar.url).toMatch(newFace);

  const picked = await ok(panel, avatars.setPreset, { style: "lorelei", seed: "Abc_123-x" }, { cookie });
  expect(picked.body.avatar).toEqual({
    kind: "preset",
    style: "lorelei",
    seed: "Abc_123-x",
    url: "/api/avatars/lorelei/Abc_123-x.svg",
    presetUrl: "/api/avatars/lorelei/Abc_123-x.svg",
  });
  expect((await ok(panel, auth.whoami, {}, { cookie })).body.viewer.avatarUrl).toBe("/api/avatars/lorelei/Abc_123-x.svg");
  expect((await call(panel, avatars.setPreset, { style: "avataaars" as "lorelei", seed: "a" }, { cookie })).status).toBe(400);
  expect((await call(panel, avatars.setPreset, { style: "lorelei", seed: "has space" }, { cookie })).status).toBe(400);

  const uploaded = await ok(panel, avatars.upload, { dataUrl: dataUrl("image/png", png) }, { cookie });
  const { avatar } = uploaded.body;
  expect(avatar).toMatchObject({ kind: "upload", style: "lorelei", seed: "Abc_123-x", presetUrl: "/api/avatars/lorelei/Abc_123-x.svg" });
  expect(avatar.url).toMatch(new RegExp(`^/api/avatars/user/${owner.user.id}\\?v=[0-9a-f]{32}$`));
  expect((await ok(panel, auth.whoami, {}, { cookie })).body.viewer.avatarUrl).toBe(avatar.url);

  const served = await get(avatar.url);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(served.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
  // Without the current version nothing answers.
  expect((await get(`/api/avatars/user/${owner.user.id}`)).status).toBe(404);
  expect((await get(`/api/avatars/user/${owner.user.id}?v=${"0".repeat(32)}`)).status).toBe(404);

  // The change is in the audit log, without the image.
  const entries = (await ok(panel, audit.list, { opId: "avatars.upload" }, { cookie })).body.entries;
  expect(entries[0]?.input.dataUrl).toBe("[redacted]");
  expect(entries[0]?.actor.avatarUrl).toBe(avatar.url);

  const removed = await ok(panel, avatars.removeUpload, {}, { cookie });
  expect(removed.body.avatar).toMatchObject({
    kind: "preset",
    style: "lorelei",
    seed: "Abc_123-x",
    url: "/api/avatars/lorelei/Abc_123-x.svg",
  });
  expect(panel.deps.db.select().from(userAvatars).all()).toHaveLength(0);
  expect((await get(avatar.url)).status).toBe(404);

  // Picking a face drops an upload.
  await ok(panel, avatars.upload, { dataUrl: dataUrl("image/webp", webp) }, { cookie });
  const face = await ok(panel, avatars.setPreset, { style: "thumbs", seed: "z" }, { cookie });
  expect(face.body.avatar.kind).toBe("preset");
  expect(panel.deps.db.select().from(userAvatars).all()).toHaveLength(0);

  // A key acts as its owner, but changing the avatar is for browser sessions.
  const bearer = createApiKey(panel, owner.user.id);
  for (const attempt of [
    call(panel, avatars.setPreset, { style: "thumbs", seed: "k" }, { bearer }),
    call(panel, avatars.upload, { dataUrl: dataUrl("image/png", png) }, { bearer }),
    call(panel, avatars.removeUpload, {}, { bearer }),
  ]) {
    expect((await attempt).status).toBe(403);
  }
});

test("uploads must be PNG, JPEG or WebP of at most 1 MB, and be what they say", async () => {
  const { cookie } = await createUser(panel, "member");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const refused = [
    dataUrl("image/svg+xml", svg),
    dataUrl("text/html", svg),
    dataUrl("image/gif", Buffer.from("GIF89a")),
    // Claims to be one type, is another (or no image at all).
    dataUrl("image/png", svg),
    dataUrl("image/png", jpeg),
    dataUrl("image/webp", png),
    dataUrl("image/jpeg", png),
    // Over 1 MiB once decoded.
    dataUrl("image/png", Buffer.concat([png, Buffer.alloc(avatarMaxBytes)])),
  ];
  for (const url of refused) {
    const res = await call(panel, avatars.upload, { dataUrl: url }, { cookie });
    expect({ type: url.slice(0, 20), status: res.status }).toEqual({ type: url.slice(0, 20), status: 400 });
  }
  expect(panel.deps.db.select().from(userAvatars).all()).toHaveLength(0);

  for (const [type, bytes] of [
    ["image/png", png],
    ["image/jpeg", jpeg],
    ["image/webp", webp],
  ] as const) {
    const res = await ok(panel, avatars.upload, { dataUrl: dataUrl(type, bytes) }, { cookie });
    expect((await get(res.body.avatar.url)).headers.get("content-type")).toBe(type);
  }
});

test("the face route draws every offered style and refuses other styles and bad seeds", async () => {
  for (const style of avatarStyles) {
    const res = await get(`/api/avatars/${style.id}/seed-1.svg`);
    expect({ style: style.id, status: res.status }).toEqual({ style: style.id, status: 200 });
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const svg = await res.text();
    expect(svg).toStartWith("<svg");
    // DiceBear writes the artwork's license into each image.
    expect(svg).toContain(style.license);
  }
  // The same seed is the same face.
  expect(await (await get("/api/avatars/micah/same.svg")).text()).toBe(await (await get("/api/avatars/micah/same.svg")).text());
  expect(await (await get("/api/avatars/micah/same.svg")).text()).not.toBe(await (await get("/api/avatars/micah/other.svg")).text());

  for (const path of ["/api/avatars/avataaars/seed.svg", "/api/avatars/bottts/seed.svg", "/api/avatars/initials/seed.svg"]) {
    expect({ path, status: (await get(path)).status }).toEqual({ path, status: 404 });
  }
  for (const path of [
    "/api/avatars/notionists/seed.png",
    "/api/avatars/notionists/bad%20seed.svg",
    "/api/avatars/notionists/%3Cscript%3E.svg",
    "/api/avatars/notionists/..%2F..%2Fpanel.svg",
    `/api/avatars/notionists/${"a".repeat(65)}.svg`,
    "/api/avatars/notionists/.svg",
  ]) {
    expect({ path, status: (await get(path)).status }).toEqual({ path, status: 400 });
  }

  const compressed = await get("/api/avatars/notionists/seed.svg", { "accept-encoding": "br" });
  expect(compressed.headers.get("content-encoding")).toBe("br");
});

test("every offered style's artwork license allows use here and matches its package; NOTICE credits the CC BY ones", () => {
  const notice = readFileSync(join(import.meta.dir, "..", "..", "..", "NOTICE"), "utf8");
  for (const style of avatarStyles) {
    const meta = dicebearStyles[style.id].meta;
    expect({ id: style.id, license: meta?.license?.name, work: meta?.title }).toEqual({
      id: style.id,
      license: style.license,
      work: style.work,
    });
    expect(meta?.creator).toContain(style.creator);
    expect(["CC0 1.0", "CC BY 4.0"]).toContain(style.license);
    if (style.license === "CC BY 4.0") {
      expect(notice).toContain(`"${style.work}" by ${style.creator}`);
    }
  }
});
