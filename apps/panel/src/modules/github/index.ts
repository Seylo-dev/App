// The per-panel GitHub App, repo pickers, connecting repos, the connected
// GitHub account (device login or pasted token) for private repos the App
// does not reach, the webhook routes (POST /api/hooks/github for the App,
// POST /api/hooks/github-repo/<id> for the account's repository webhooks)
// and the branch polling fallback.

import { Elysia } from "elysia";
import { defineModule } from "../module";
import { githubWebhookPath } from "./app";
import { githubHandlers } from "./ops";
import { pollJob, pollSchedule } from "./poll";
import { repoHookRoutes } from "./repo-hook-route";
import { removeRepoHookJob } from "./repo-hooks";
import { githubWebhookRoute } from "./webhook";

export { githubWebhookPath };

export default defineModule({
  name: "github",
  ops: githubHandlers,
  jobs: [pollJob, removeRepoHookJob],
  http: (deps) => new Elysia().use(githubWebhookRoute(deps)).use(repoHookRoutes(deps)),
  start(deps) {
    // A schedule: a job that re-enqueues itself with its own dedupe key is dropped while it still runs.
    deps.schedules.ensure(pollSchedule);
  },
});
