// GitLab, Gitea/Forgejo and Bitbucket Cloud connections: repo and branch
// pickers, private clones with the connection's token (only to its host),
// a webhook per connected repository (POST /api/hooks/<kind>/<id>) for
// push-to-deploy and merge/pull request previews, branch polling as the
// fallback, and commit statuses back to the provider.

import { onDeploymentChange } from "../deployments/store";
import { defineModule } from "../module";
import { removeHookJob } from "./hooks";
import { providerHandlers } from "./ops";
import { pollJob, pollSchedule } from "./poll";
import { commitStatusJob, observeDeployment } from "./status";
import { providerWebhookRoutes } from "./webhook";

export default defineModule({
  name: "gitProviders",
  ops: providerHandlers,
  jobs: [removeHookJob, commitStatusJob, pollJob],
  http: (deps) => providerWebhookRoutes(deps),
  start(deps) {
    deps.schedules.ensure(pollSchedule);
    onDeploymentChange(deps.db, (row) => observeDeployment(deps, row));
  },
});
