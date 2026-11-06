import { OpError, projects } from "@seylo/ops";
import { userOf } from "../../auth/principal";
import { implement } from "../../ops/implement";
import { selectProjects, toProject } from "./rows";

export const get = implement(projects.get, (input, ctx) => {
  const [view] = selectProjects(ctx.db, userOf(ctx.principal)?.id ?? null, input.projectId);
  if (!view) throw new OpError("NOT_FOUND", "No project with this id.");
  return toProject(view);
});
