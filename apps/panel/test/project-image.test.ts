// A project's image (0.2.6): projects.setImage stores an uploaded PNG, JPEG
// or WebP for everyone who sees the project, every project read carries its
// URL, the avatars route serves it only with its current hash, and
// projects.removeImage brings the initial back. Same file rules as a
// person's uploaded avatar.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { avatarMaxBytes, projects as projectOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog, projectImages } from "../src/db/schema";
import { createUser, grant, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, ok, seedProject } from "./people-helpers";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
const imagePath = /^\/api\/avatars\/project\/[a-z0-9]+\?v=[0-9a-f]{32}$/;

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel({ rateLimiter: noLimits });
});
afterEach(() => panel.close());

function get(path: string) {
  return panel.app.handle(new Request(`http://panel.test${path}`, { headers: { host: "panel.test" } }));
}

test("an uploaded image shows on every project read, is served with its hash only, and removing it brings the initial back", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel, "5Stacks");
  const before = await ok(panel, projectOps.get, { projectId: project.id }, { cookie: owner.cookie });
  expect(before.body.imageUrl).toBeNull();

  const set = await ok(panel, projectOps.setImage, { projectId: project.id, dataUrl: dataUrl("image/png", png) }, { cookie: owner.cookie });
  const url = set.body.imageUrl as string;
  expect(url).toMatch(imagePath);
  expect(url.startsWith(`/api/avatars/project/${project.id}?v=`)).toBe(true);
  const listed = await ok(panel, projectOps.list, {}, { cookie: owner.cookie });
  expect(listed.body.projects.find((p: { id: string }) => p.id === project.id)?.imageUrl).toBe(url);
  expect((await ok(panel, projectOps.get, { projectId: project.id }, { cookie: owner.cookie })).body.imageUrl).toBe(url);

  // The route needs no session (img tags send none) but answers only with the current hash.
  const served = await get(url);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(served.headers.get("x-content-type-options")).toBe("nosniff");
  expect(served.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
  expect((await get(`/api/avatars/project/${project.id}`)).status).toBe(404);
  expect((await get(`/api/avatars/project/${project.id}?v=${"0".repeat(32)}`)).status).toBe(404);

  // A new image is a new URL; the old one stops answering.
  const again = await ok(
    panel,
    projectOps.setImage,
    { projectId: project.id, dataUrl: dataUrl("image/webp", webp) },
    { cookie: owner.cookie },
  );
  expect(again.body.imageUrl).not.toBe(url);
  expect((await get(url)).status).toBe(404);
  expect((await get(again.body.imageUrl as string)).headers.get("content-type")).toBe("image/webp");

  const removed = await ok(panel, projectOps.removeImage, { projectId: project.id }, { cookie: owner.cookie });
  expect(removed.body.imageUrl).toBeNull();
  expect((await get(again.body.imageUrl as string)).status).toBe(404);
});

test("SVG, a renamed file, an empty file and anything over 1 MiB are refused", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const svg = await call(
    panel,
    projectOps.setImage,
    { projectId: project.id, dataUrl: dataUrl("image/svg+xml", Buffer.from("<svg/>")) },
    { cookie: owner.cookie },
  );
  expect(svg.status).toBe(400);
  const renamed = await call(
    panel,
    projectOps.setImage,
    { projectId: project.id, dataUrl: dataUrl("image/png", Buffer.from("<html>hi</html>")) },
    { cookie: owner.cookie },
  );
  expect(renamed.status).toBe(400);
  expect(JSON.stringify(renamed.body)).toContain("not a PNG image");
  const big = Buffer.concat([png, Buffer.alloc(avatarMaxBytes)]);
  expect(
    (await call(panel, projectOps.setImage, { projectId: project.id, dataUrl: dataUrl("image/png", big) }, { cookie: owner.cookie }))
      .status,
  ).toBe(400);
  expect((await ok(panel, projectOps.get, { projectId: project.id }, { cookie: owner.cookie })).body.imageUrl).toBeNull();
});

test("changing the image takes projects.update on the project; viewers see it but cannot change it", async () => {
  const owner = await createUser(panel, "owner");
  const viewer = await createUser(panel, "member");
  const editor = await createUser(panel, "member");
  const project = seedProject(panel);
  grant(panel, viewer.user.id, "project", project.id, ["projects.view"]);
  grant(panel, editor.user.id, "project", project.id, ["projects.view", "projects.update"]);
  const image = dataUrl("image/png", png);

  expect((await call(panel, projectOps.setImage, { projectId: project.id, dataUrl: image }, { cookie: viewer.cookie })).status).toBe(403);
  const set = await ok(panel, projectOps.setImage, { projectId: project.id, dataUrl: image }, { cookie: editor.cookie });
  expect((await ok(panel, projectOps.get, { projectId: project.id }, { cookie: viewer.cookie })).body.imageUrl).toBe(set.body.imageUrl);
  expect((await call(panel, projectOps.removeImage, { projectId: project.id }, { cookie: viewer.cookie })).status).toBe(403);
  expect((await ok(panel, projectOps.removeImage, { projectId: project.id }, { cookie: owner.cookie })).body.imageUrl).toBeNull();
});

test("the audit row says the image changed without the image itself", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  await ok(panel, projectOps.setImage, { projectId: project.id, dataUrl: dataUrl("image/png", png) }, { cookie: owner.cookie });
  const rows = panel.deps.db.select({ input: auditLog.input }).from(auditLog).where(eq(auditLog.opId, "projects.setImage")).all();
  expect(rows.length).toBe(1);
  expect(JSON.stringify(rows[0]?.input)).not.toContain(png.toString("base64"));
});

test("deleting a project deletes its image", async () => {
  const owner = await createUser(panel, "owner");
  const project = seedProject(panel);
  const set = await ok(panel, projectOps.setImage, { projectId: project.id, dataUrl: dataUrl("image/png", png) }, { cookie: owner.cookie });
  await ok(panel, projectOps.remove, { projectId: project.id, confirmName: project.name }, { cookie: owner.cookie });
  expect((await get(set.body.imageUrl as string)).status).toBe(404);
  expect(panel.deps.db.select().from(projectImages).all()).toEqual([]);
});
