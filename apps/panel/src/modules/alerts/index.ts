// The alert feed and mutes, and where agent events become alerts
// (events.ts). Anything else in the panel raises alerts through
// deps.alerts (sink.ts); delivery is the notifications module's job.
// Contracts: packages/ops/src/ops/alerts.ts.

import { defineModule } from "../module";
import { nodeOfflineJob, subscribeAgentEvents } from "./events";
import { list, mute, mutes, unmute } from "./feed";

export default defineModule({
  name: "alerts",
  ops: [list, mutes, mute, unmute],
  jobs: [nodeOfflineJob],
  start: subscribeAgentEvents,
});
