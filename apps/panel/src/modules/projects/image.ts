// A project's image (0.2.6): an uploaded PNG, JPEG or WebP shown instead of
// its initial, for everyone who sees the project. Same rules as a person's
// uploaded avatar (avatars/store.ts parses and checks the bytes); served by
// avatars/http.ts at /api/avatars/project/<id>?v=<hash>.

import { createHash } from "node:crypto";
import { OpError, projects as projectOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { projectImages, projects } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { parseAvatarUpload } from "../avatars/store";
import { selectProjects, toProject } from "./rows";

function viewOf(ctx: OpContext, projectId: string) {
  const [view] = selectProjects(ctx.db, userOf(ctx.principal)?.id ?? null, projectId);
  if (!view) throw new OpError("NOT_FOUND", "No project with this id.");
  return view;
}

/** Everyone's sidebar, dashboard and the project's own page show the change. */
function changed(ctx: OpContext, projectId: string) {
  ctx.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId)).run();
  ctx.live.publish("panel", { type: "invalidate", ops: [projectOps.list.id] });
  ctx.live.publish(`project:${projectId}`, { type: "invalidate", ops: [projectOps.get.id] });
  return toProject(viewOf(ctx, projectId));
}

export const setImage = implement(projectOps.setImage, (input, ctx) => {
  const { project } = viewOf(ctx, input.projectId);
  const image = parseAvatarUpload(input.dataUrl);
  const hash = createHash("sha256").update(image.bytes).digest("hex").slice(0, 32);
  ctx.db
    .insert(projectImages)
    .values({ projectId: project.id, contentType: image.contentType, hash, bytes: image.bytes })
    .onConflictDoUpdate({
      target: projectImages.projectId,
      set: { contentType: image.contentType, hash, bytes: image.bytes, createdAt: new Date() },
    })
    .run();
  return changed(ctx, project.id);
});

export const removeImage = implement(projectOps.removeImage, (input, ctx) => {
  const { project } = viewOf(ctx, input.projectId);
  ctx.db.delete(projectImages).where(eq(projectImages.projectId, project.id)).run();
  return changed(ctx, project.id);
});
