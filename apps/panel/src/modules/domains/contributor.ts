// The networking desired-state contributor (desired/contributors.ts): after
// the compiler's own mapping it sets, from the domains, env, databases,
// exposures, tunnels, boxes and maintenance modules, a service's routing
// (domains, middlewares, maintenance and down page), dev access (timed
// exposes, Cloudflare tunnel), first-run IP:port access on its port, its
// environment (references resolved, shared variables, engine variables)
// and the database and Box kind specs; and the global maintenance page in
// NodeSettings. Registered once in the domains module's start().

import { create } from "@bufbuild/protobuf";
import {
  BoxSpecSchema,
  DatabaseSpecSchema,
  DevAccessSchema,
  EnvVarSchema,
  MaintenanceSchema,
  PublicPortSchema,
  RoutingSchema,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import { deployments } from "../../db/schema";
import type { DesiredContributor } from "../../desired/contributors";
import { boxRuntime } from "../boxes/desired";
import { databaseRuntime } from "../databases/desired";
import { deploymentEnv, resolveServiceEnv } from "../env/desired";
import { globalMaintenance, serviceNetworking } from "./desired";

export const networkingContributor: DesiredContributor = {
  name: "networking-env-data",
  service({ db, secrets, nodeId, service, spec }) {
    const deps = { db, secrets };
    const net = serviceNetworking(deps, service.id, nodeId);
    spec.routing = create(RoutingSchema, net.routing);
    spec.devAccess = create(DevAccessSchema, net.devAccess);
    for (const port of spec.ports) {
      const wanted = net.publicPorts.find((p) => p.containerPort === port.containerPort);
      if (wanted) {
        const { containerPort: _, ...publicPort } = wanted;
        port.public = create(PublicPortSchema, publicPort);
      } else {
        port.public = undefined;
      }
    }
    // Apps run the env their target deployment started with (a failed deploy
    // must not hand its new env to the live one); databases and Boxes have
    // no deployment and get the current env.
    const target = service.targetDeploymentId
      ? db.select({ envSealed: deployments.envSealed }).from(deployments).where(eq(deployments.id, service.targetDeploymentId)).get()
      : undefined;
    const env = deploymentEnv(deps, target?.envSealed ?? null) ?? resolveServiceEnv(deps, service.id);
    spec.env = env.map((v) => create(EnvVarSchema, v));
    const database = databaseRuntime(deps, service.id, nodeId);
    if (database) spec.kindSpec = { case: "database", value: create(DatabaseSpecSchema, database.database) };
    const box = boxRuntime(deps, service.id);
    if (box) spec.kindSpec = { case: "box", value: create(BoxSpecSchema, box.box) };
  },
  node({ db, settings }) {
    settings.maintenance = create(MaintenanceSchema, globalMaintenance(db));
  },
};
