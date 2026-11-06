// Docker Hub as a template source: search, tags and image configs read
// through the panel (only Docker Hub's hosts are contacted, answers are
// cached, rate limits kept; see client.ts), and dockerHub.create for the
// one-click app (create.ts).

import { dockerHub as hubOps } from "@seylo/ops";
import type { Deps } from "../../deps";
import { implement } from "../../ops/implement";
import { defineModule } from "../module";
import { DockerHubClient } from "./client";
import { createFromDockerHub } from "./create";
import { callerAccess } from "./login";

// One client (and so one cache and one rate-limit memory) per panel.
const clients = new WeakMap<object, DockerHubClient>();

export function dockerHubClient(deps: Pick<Deps, "db" | "logger">): DockerHubClient {
  let client = clients.get(deps.db);
  if (!client) {
    client = new DockerHubClient({ warn: (message, fields) => deps.logger.warn(fields ?? {}, message) });
    clients.set(deps.db, client);
  }
  return client;
}

const search = implement(hubOps.search, (input, ctx) => dockerHubClient(ctx).search(input.query, input.page ?? 1));

const tags = implement(hubOps.tags, (input, ctx) =>
  dockerHubClient(ctx).tags(input.repository, { page: input.page ?? 1, filter: input.filter, access: callerAccess(ctx) }),
);

const inspect = implement(hubOps.inspect, (input, ctx) =>
  dockerHubClient(ctx).inspect(input.repository, input.tag, input.arch ?? "amd64", callerAccess(ctx)),
);

const create = implement(hubOps.create, (input, ctx) => createFromDockerHub(ctx, input));

export default defineModule({ name: "dockerHub", ops: [search, tags, inspect, create] });
