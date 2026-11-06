// The per-panel GitHub App, repo pickers, connecting repos, the device-flow
// token for private repos, the webhook route (POST /api/hooks/github) and
// the branch polling fallback.

import { defineModule } from "../module";
import { githubWebhookPath } from "./app";
import { githubHandlers } from "./ops";
import { pollJob, pollSchedule } from "./poll";
import { githubWebhookRoute } from "./webhook";

export { githubWebhookPath };

export default defineModule({
  name: "github",
  ops: githubHandlers,
  jobs: [pollJob],
  http: (deps) => githubWebhookRoute(deps),
  start(deps) {
    // A schedule: a job that re-enqueues itself with its own dedupe key is dropped while it still runs.
    deps.schedules.ensure(pollSchedule);
  },
});
