import { projects } from "@seylo/ops";
import { userOf } from "../../auth/principal";
import { implement } from "../../ops/implement";
import { selectProjects, toProject } from "./rows";

export const list = implement(projects.list, (_input, ctx) => {
  const visible = selectProjects(ctx.db, userOf(ctx.principal)?.id ?? null).filter(({ project }) =>
    ctx.access.can("projects.view", { type: "project", id: project.id }),
  );
  return { projects: visible.map(toProject) };
});
