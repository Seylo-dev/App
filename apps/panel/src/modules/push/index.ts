// The installable app and push notifications (0.2.7): the admin switch
// (only on the panel domain over HTTPS), people's devices and event
// choices, the alert fan-out (alerts/sink.ts enqueues push.fanout) and the
// web app manifest. Contracts: packages/ops/src/ops/push.ts.

import { defineModule } from "../module";
import { manifestRoutes } from "./http";
import { pushOpHandlers } from "./ops";
import { fanoutJob, revokeJob, revokeOnStart, sendJob } from "./send";

export default defineModule({
  name: "push",
  ops: pushOpHandlers,
  jobs: [fanoutJob, sendJob, revokeJob],
  http: manifestRoutes,
  start: revokeOnStart,
});
