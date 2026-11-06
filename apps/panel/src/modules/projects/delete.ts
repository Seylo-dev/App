import { OpError, projects as projectOps } from "@seylo/ops";
import { and, eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { grants, projects } from "../../db/schema";
import { implement } from "../../ops/implement";
import { selectProjects } from "./rows";

export const remove = implement(projectOps.remove, (input, ctx) => {
  const [view] = selectProjects(ctx.db, userOf(ctx.principal)?.id ?? null, input.projectId);
  if (!view) throw new OpError("NOT_FOUND", "No project with this id.");
  const { project } = view;
  const { serviceCount } = view.counts;

  if (project.protected) throw new OpError("CONFLICT", `${project.name} runs the panel and cannot be deleted.`);
  if (input.confirmName !== project.name) {
    throw new OpError("BAD_REQUEST", "Type the project name exactly to confirm.", { field: "confirmName" });
  }
  if (serviceCount > 0) {
    throw new OpError("CONFLICT", `Delete the project's ${serviceCount} service(s) first.`);
  }

  ctx.db.transaction((tx) => {
    tx.delete(grants)
      .where(and(eq(grants.scopeType, "project"), eq(grants.scopeId, project.id)))
      .run();
    tx.delete(projects).where(eq(projects.id, project.id)).run();
  });
  ctx.live.publish("panel", { type: "invalidate", ops: [projectOps.list.id] });
  ctx.live.publish(`project:${project.id}`, { type: "invalidate", ops: [projectOps.get.id] });
  return {};
});
