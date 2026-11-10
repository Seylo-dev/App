import { OpError, projects as projectOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { projects } from "../../db/schema";
import { implement } from "../../ops/implement";
import { nameKey, toProject } from "./rows";

export const create = implement(projectOps.create, (input, ctx) => {
  const name = input.name.trim();
  const key = nameKey(name);
  if (ctx.db.select({ id: projects.id }).from(projects).where(eq(projects.nameKey, key)).get()) {
    throw new OpError("CONFLICT", `A project named "${name}" already exists.`, { field: "name" });
  }

  const row = ctx.db
    .insert(projects)
    .values({ name, nameKey: key, description: input.description?.trim() ?? "", createdBy: userOf(ctx.principal)?.id ?? null })
    .returning()
    .get();
  ctx.live.publish("panel", { type: "invalidate", ops: [projectOps.list.id] });
  return toProject({
    project: row,
    counts: { serviceCount: 0, nodeCount: 0, guestCount: 0 },
    prefs: { collapsed: false, position: null },
    imageHash: null,
  });
});
