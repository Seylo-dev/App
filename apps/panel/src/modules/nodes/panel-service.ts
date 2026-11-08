// The panel as a protected service (installer "panel + node here", part 2).
// The installer starts the first panel container itself, labelled as
// service panel00000000000 in project panelproject0000 at generation 1, and
// passes SEYLO_IMAGE and SEYLO_HOST_PORT. Once the local agent joined (the
// panel node), ensurePanelService() creates the matching rows: the
// protected "Panel" project, the "panel" service placed on that node and a
// live generation-1 deployment of that image, so the first desired state
// names exactly what runs and the agent adopts the container instead of
// starting a second panel on the same database.
//
// After a panel update the agent has swapped the container to the release's
// image at generation + 1 (update.PanelSwapper). The new panel records that
// image before anything compiles a desired state (syncPanelImage), so the
// first sync after the swap matches the running container. After a rollback
// the agent restored the old database, whose rows already match.
//
// panelContributor keeps the service's spec as the installer made it (env,
// the published port, the "panel" alias, recreate deploys, no volumes: the
// agent binds the data dir itself) and routes the panel domain to it.
//
// The spec never names the panel's user: the agent runs the panel as its
// panel user (go/internal/docker PanelUser, uid 61000) after giving the data
// dir to it. A user in the spec would make an agent from before 0.2.0-rc.2,
// which does not move the folder, start the panel as that user on a folder
// uid 1000 still owns.

import { create } from "@bufbuild/protobuf";
import {
  DeployMode,
  EnvVarSchema,
  HttpsMode,
  PortProtocol,
  PortSpecSchema,
  PublicPortMode,
  RouteSchema,
  RoutingSchema,
} from "@seylo/proto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { envPrefix } from "../../config";
import { deployments, nodes, projects, servicePlacements, services, updateRuns, updateSteps } from "../../db/schema";
import type { Deps } from "../../deps";
import type { DesiredContributor } from "../../desired/contributors";
import { getSetting, setSetting } from "../../settings";
import { defaultSpec, runSettingsOf, type ServiceSpecJson } from "../services/spec";
import { runRelease } from "../updates/release-state";

/** Reserved ids, the same as go/internal/docker (PanelProjectID, PanelServiceID). */
export const panelProjectId = "panelproject0000";
export const panelServiceId = "panel00000000000";
export const panelServiceName = "panel";
export const panelContainerPort = 3000;

declare module "../../settings" {
  interface SettingValues {
    /** Host port the installer published the panel on; the panel service keeps publishing it. */
    panelHostPort: number;
    /** The agents' TLS port (SEYLO_AGENT_TLS_PORT); the panel service keeps it set and published. */
    panelAgentTlsPort: number;
  }
}

export interface ImageRef {
  reference: string;
  digest: string | null;
}

/** "ghcr.io/x/seylo:0.1.0@sha256:..." -> reference and digest. */
export function splitImage(image: string): ImageRef {
  const at = image.indexOf("@sha256:");
  return at < 0 ? { reference: image, digest: null } : { reference: image.slice(0, at), digest: image.slice(at + 1) };
}

function panelSpec(image: ImageRef): ServiceSpecJson {
  const base = defaultSpec();
  return {
    ...base,
    source: { type: "image", image: image.reference, registryId: null },
    ports: [{ containerPort: panelContainerPort, protocol: "tcp" }],
    healthCheck: {
      probe: { type: "http", port: panelContainerPort, path: "/api/health", host: "", expectedStatus: 200 },
      intervalSeconds: 10,
      timeoutSeconds: 5,
      startPeriodSeconds: 5,
      failureThreshold: 3,
    },
    // Two panels never share panel.db: stop the old one before the new one starts.
    deploy: { mode: "recreate", healthTimeoutSeconds: 300 },
  };
}

export type EnsureResult = "created" | "updated" | "unchanged" | "skipped";

/**
 * Creates the Panel project and panel service rows once the panel node
 * exists, or records the image a panel update swapped in. Safe to call on
 * every start and every connect. Rows are only created by an installed panel
 * (SEYLO_IMAGE set), so development and tests are untouched.
 */
export function ensurePanelService(deps: Pick<Deps, "db" | "config" | "logger">, now = new Date()): EnsureResult {
  const { db, config } = deps;
  if (config.hostPort !== null && getSetting(db, "panelHostPort") !== config.hostPort) setSetting(db, "panelHostPort", config.hostPort);
  if (config.agentTlsPort !== null && getSetting(db, "panelAgentTlsPort") !== config.agentTlsPort) {
    setSetting(db, "panelAgentTlsPort", config.agentTlsPort);
  }
  // A swapped-in panel runs with the env of the stored spec, which has no image variable
  // (it would differ after every update): the rows exist by then and the release says the image.
  const existing = db.select({ id: services.id }).from(services).where(eq(services.id, panelServiceId)).get();
  if (existing) return syncPanelImage(deps, now) ? "updated" : "unchanged";
  if (!config.image) return "skipped";

  const panelNode = db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
  if (!panelNode) return "skipped";
  const image = splitImage(config.image);
  const spec = panelSpec(image);
  db.transaction((tx) => {
    if (!tx.select({ id: projects.id }).from(projects).where(eq(projects.id, panelProjectId)).get()) {
      // A project someone already called "Panel" keeps its name; ours gets a suffix.
      const taken = tx.select({ id: projects.id }).from(projects).where(eq(projects.nameKey, "panel")).get();
      const name = taken ? "Panel (system)" : "Panel";
      tx.insert(projects)
        .values({
          id: panelProjectId,
          name,
          nameKey: name.toLowerCase(),
          description: "The panel itself.",
          protected: true,
          createdAt: now,
        })
        .run();
    }
    tx.insert(services)
      .values({
        id: panelServiceId,
        projectId: panelProjectId,
        name: panelServiceName,
        nameKey: panelServiceName,
        kind: "app",
        spec,
        generation: 1,
        protected: true,
        notes: "The panel itself. It updates with Settings > Updates.",
        createdAt: now,
      })
      .run();
    tx.insert(servicePlacements).values({ serviceId: panelServiceId, nodeId: panelNode.id, replicas: 1 }).run();
    const deployment = tx
      .insert(deployments)
      .values({
        serviceId: panelServiceId,
        generation: 1,
        status: "live",
        trigger: "manual",
        actor: null,
        imageRef: image.reference,
        imageDigest: image.digest,
        targetNodeIds: [panelNode.id],
        runSettings: runSettingsOf(spec) as unknown as Record<string, unknown>,
        steps: [],
        startedAt: now,
        finishedAt: now,
        createdAt: now,
      })
      .returning({ id: deployments.id })
      .get();
    tx.update(services).set({ targetDeploymentId: deployment.id }).where(eq(services.id, panelServiceId)).run();
  });
  deps.logger.info({ serviceId: panelServiceId, nodeId: panelNode.id, image: config.image }, "recorded the installer's panel as a service");
  return "created";
}

/**
 * After a successful UpdatePanel the agent runs the release's panel image
 * at the next generation, and this panel is that image (its version is the
 * running panel step's target). Records it as the live deployment. Returns
 * true when a row changed. Idempotent: a restart later changes nothing.
 *
 * The image comes from the manifest of the run that owns the step, so a
 * check or a switch of the release channel while the image pulled does not
 * matter. Only a run made before 0.2.0-rc.2 (no manifest of its own) falls
 * back to the stored check, while that still names this version.
 */
export function syncPanelImage(deps: Pick<Deps, "db" | "config" | "logger">, now = new Date()): boolean {
  const { db, config } = deps;
  const owner = db
    .select({ run: updateRuns })
    .from(updateSteps)
    .innerJoin(updateRuns, eq(updateRuns.id, updateSteps.runId))
    .where(
      and(
        eq(updateSteps.target, "panel"),
        inArray(updateSteps.status, ["running", "succeeded"]),
        eq(updateSteps.toVersion, config.version),
      ),
    )
    .orderBy(desc(updateRuns.createdAt))
    .get();
  if (!owner) return false;
  const release = runRelease(db, owner.run);
  if (!release?.panelImage || !release.panelDigest) return false;
  const image = { reference: release.panelImage, digest: release.panelDigest };
  const svc = db.select().from(services).where(eq(services.id, panelServiceId)).get();
  const live = svc?.targetDeploymentId ? db.select().from(deployments).where(eq(deployments.id, svc.targetDeploymentId)).get() : undefined;
  if (!svc || !live || live.imageDigest === image.digest) return false;
  db.transaction((tx) => {
    tx.update(deployments).set({ status: "superseded" }).where(eq(deployments.id, live.id)).run();
    const generation = live.generation + 1;
    const next = tx
      .insert(deployments)
      .values({
        serviceId: svc.id,
        generation,
        status: "live",
        trigger: "manual",
        actor: null,
        imageRef: image.reference,
        imageDigest: image.digest,
        targetNodeIds: live.targetNodeIds,
        runSettings: live.runSettings,
        steps: [],
        startedAt: now,
        finishedAt: now,
        createdAt: now,
      })
      .returning({ id: deployments.id })
      .get();
    const spec = { ...(svc.spec as ServiceSpecJson), source: { type: "image" as const, image: image.reference, registryId: null } };
    tx.update(services).set({ targetDeploymentId: next.id, generation, spec }).where(eq(services.id, svc.id)).run();
  });
  deps.logger.info({ serviceId: svc.id, image: `${image.reference}@${image.digest}` }, "recorded the updated panel image");
  return true;
}

/**
 * Runs after every other contributor: the panel service keeps the
 * installer's env and published port whatever the generic code would add,
 * and the panel domain routes to it.
 */
export const panelContributor: DesiredContributor = {
  name: "panel-service",
  order: 1000,
  service({ db, service, spec }) {
    if (service.id !== panelServiceId) return;
    const hostPort = getSetting(db, "panelHostPort") ?? panelContainerPort;
    const agentTlsPort = getSetting(db, "panelAgentTlsPort") ?? null;
    spec.env = [
      ["PORT", String(panelContainerPort)],
      ["HOST_PORT", String(hostPort)],
      ["SECURE_COOKIES", "false"],
      ...(agentTlsPort ? [["AGENT_TLS_PORT", String(agentTlsPort)]] : []),
    ].map(([name, value]) => create(EnvVarSchema, { name: `${envPrefix}${name}`, value }));
    spec.ports = [
      create(PortSpecSchema, {
        containerPort: panelContainerPort,
        protocol: PortProtocol.TCP,
        public: { hostPort, mode: PublicPortMode.FORWARD },
      }),
      // The agents' TLS listener, published like the panel port (the same number on the host).
      ...(agentTlsPort
        ? [
            create(PortSpecSchema, {
              containerPort: agentTlsPort,
              protocol: PortProtocol.TCP,
              public: { hostPort: agentTlsPort, mode: PublicPortMode.FORWARD },
            }),
          ]
        : []),
    ];
    spec.networkAliases = [panelServiceName];
    spec.volumes = [];
    spec.files = [];
    spec.replicas = 1;
    spec.loadBalancer = undefined;
    spec.devAccess = undefined;
    if (spec.deploy) spec.deploy.mode = DeployMode.RECREATE;
    const domain = getSetting(db, "panelDomain");
    spec.routing = create(RoutingSchema, {
      routes: domain
        ? [
            create(RouteSchema, {
              id: panelServiceId,
              hosts: [domain],
              targetPort: panelContainerPort,
              https: HttpsMode.ACME,
              redirectToHttps: true,
            }),
          ]
        : [],
    });
  },
};
