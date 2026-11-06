// Services: create, read, settings, notes, placements, run state, delete,
// moves between nodes and projects, and clones; plus the archive upload
// endpoint. Other modules create service rows
// through insert.ts (insertService) and deploy through deployments/queue.ts.
// The desired-state compiler maps services with desired.ts (serviceSpecFor).

import { defineModule } from "../module";
import { clone, cloneDataJob, clonePreview } from "./clone";
import { remove } from "./delete";
import { move, moveJob } from "./move";
import { moveProject, moveProjectImpact } from "./move-project";
import { serviceOpsHandlers } from "./ops";
import { uploadRoutes } from "./upload";

export default defineModule({
  name: "services",
  ops: [...serviceOpsHandlers, remove, move, clonePreview, clone, moveProjectImpact, moveProject],
  jobs: [moveJob, cloneDataJob],
  http: (deps) => uploadRoutes(deps),
});

export { deleteServiceTree } from "./delete";
export { serviceSpecFor, servicesOnNode } from "./desired";
export { type InsertServiceInput, insertService } from "./insert";
