import { OpError, projects as projectOps } from "@seylo/ops";
import { and, eq, ne } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { projects } from "../../db/schema";
import { implement } from "../../ops/implement";
import { nameKey, selectProjects, toProject } from "./rows";

export const update = implement(projectOps.update, (input, ctx) => {
  const userId = userOf(ctx.principal)?.id ?? null;
  const [view] = selectProjects(ctx.db, userId, input.projectId);
  if (!view) throw new OpError("NOT_FOUND", "No project with this id.");
  const { project } = view;

  const changes: Partial<typeof projects.$inferInsert> = {};
  if (input.name !== undefined && input.name.trim() !== project.name) {
    if (project.protected) throw new OpError("CONFLICT", `${project.name} runs the panel and cannot be renamed.`, { field: "name" });
    const name = input.name.trim();
    const key = nameKey(name);
    const taken = ctx.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.nameKey, key), ne(projects.id, project.id)))
      .get();
    if (taken) throw new OpError("CONFLICT", `A project named "${name}" already exists.`, { field: "name" });
    changes.name = name;
    changes.nameKey = key;
  }
  if (input.description !== undefined) changes.description = input.description.trim();

  if (Object.keys(changes).length > 0) {
    ctx.db.update(projects).set(changes).where(eq(projects.id, project.id)).run();
    ctx.live.publish("panel", { type: "invalidate", ops: [projectOps.list.id] });
    ctx.live.publish(`project:${project.id}`, { type: "invalidate", ops: [projectOps.get.id] });
  }
  const [updated] = selectProjects(ctx.db, userId, project.id);
  if (!updated) throw new OpError("NOT_FOUND", "No project with this id.");
  return toProject(updated);
});
