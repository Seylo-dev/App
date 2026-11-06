// Services: create, read, settings, notes, placements, run state, delete and
// moves; plus the archive upload endpoint. Other modules create service rows
// through insert.ts (insertService) and deploy through deployments/queue.ts.
// The desired-state compiler maps services with desired.ts (serviceSpecFor).

import { defineModule } from "../module";
import { remove } from "./delete";
import { move, moveJob } from "./move";
import { serviceOpsHandlers } from "./ops";
import { uploadRoutes } from "./upload";

export default defineModule({
  name: "services",
  ops: [...serviceOpsHandlers, remove, move],
  jobs: [moveJob],
  http: (deps) => uploadRoutes(deps),
});

export { deleteServiceTree } from "./delete";
export { serviceSpecFor, servicesOnNode } from "./desired";
export { type InsertServiceInput, insertService } from "./insert";
