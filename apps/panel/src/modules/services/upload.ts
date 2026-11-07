// Upload sources: POST /api/uploads/services/<serviceId> with a .tar.gz
// body (header x-file-name for display) stores the archive on the panel,
// switches the service's source to "upload" and deploys it. Not an op
// because the body is a file, not JSON; the same permission (services.deploy)
// and audit-worthy deploy record apply.

import { createHash } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { OpError } from "@seylo/ops";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { createAccess } from "../../auth/access";
import { authenticate, credentialsFrom, signedOutError } from "../../auth/authenticate";
import { userOf } from "../../auth/principal";
import { deployments, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import { secureSession } from "../../http/https";
import { isSameOrigin } from "../../http/origin";
import { newId } from "../../ids";
import { queueDeploy } from "../deployments/queue";
import { toDeployment } from "../deployments/store";
import { writeSpec } from "./insert";
import { publishService } from "./ops";
import { loadService } from "./rows";
import { readSpec } from "./spec";

export const uploadPath = "/api/uploads/services";
/** Largest archive accepted. */
export const maxUploadBytes = 512 * 1024 * 1024;

function fail(error: OpError) {
  return new Response(JSON.stringify(error.toBody()), { status: error.status, headers: { "content-type": "application/json" } });
}

export function uploadRoutes(deps: Deps) {
  return new Elysia().post(`${uploadPath}/:serviceId`, async ({ request, params, server }) => {
    try {
      const socketIp = server?.requestIP(request)?.address ?? null;
      if (!isSameOrigin(request, deps.proxy.trusts(socketIp))) throw new OpError("FORBIDDEN", "Cross-site requests are not allowed.");
      const credentials = credentialsFrom(request, { secure: secureSession(deps, request, socketIp) });
      const principal = authenticate(deps.db, credentials);
      const access = createAccess(deps.db, principal);
      const user = userOf(principal);
      if (!user) throw signedOutError(credentials);
      if (principal.type === "apiKey" && principal.readOnly) throw new OpError("FORBIDDEN", "This key is read-only.");
      const svc = loadService(deps.db, params.serviceId);
      if (
        !access.can("services.deploy", { type: "service", id: svc.id }) ||
        !access.can("services.update", { type: "service", id: svc.id })
      ) {
        throw new OpError("FORBIDDEN", "You cannot deploy this service.", { action: "services.deploy" });
      }
      if (svc.kind !== "app" && svc.kind !== "cron") throw new OpError("CONFLICT", "Only app and cron services take uploads.");
      if (svc.parentId) throw new OpError("CONFLICT", "Compose members build from their stack.");
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > maxUploadBytes) throw new OpError("BAD_REQUEST", `Archives are limited to ${maxUploadBytes / 1024 / 1024} MB.`);
      if (!request.body) throw new OpError("BAD_REQUEST", "Send the archive as the request body.");
      const fileName = (request.headers.get("x-file-name") ?? "upload.tar.gz").replace(/[^\w.\- ]/g, "_").slice(0, 120);

      const id = newId();
      const dir = join(deps.config.dataDir, "uploads");
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${id}.part`);
      const hash = createHash("sha256");
      let size = 0;
      const sink = Bun.file(tmp).writer();
      try {
        for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength;
          if (size > maxUploadBytes) throw new OpError("BAD_REQUEST", `Archives are limited to ${maxUploadBytes / 1024 / 1024} MB.`);
          hash.update(chunk);
          sink.write(chunk);
        }
        await sink.end();
      } catch (error) {
        await sink.end();
        await rm(tmp, { force: true });
        throw error;
      }
      // gzip magic: anything else is not a .tar.gz.
      const head = new Uint8Array(await Bun.file(tmp).slice(0, 2).arrayBuffer());
      if (size === 0 || head[0] !== 0x1f || head[1] !== 0x8b) {
        await rm(tmp, { force: true });
        throw new OpError("BAD_REQUEST", "Upload a .tar.gz archive.");
      }
      await rename(tmp, join(dir, `${id}.tar.gz`));

      deps.db
        .insert(sourceUploads)
        .values({ id, serviceId: svc.id, fileName, sizeBytes: size, sha256: hash.digest("hex"), uploadedBy: user.id })
        .run();
      await pruneUploads(deps, svc.id, dir);
      writeSpec(deps.db, svc.id, { ...readSpec(svc.spec), source: { type: "upload", fileName } });
      publishService(deps, svc);
      const actor = principal.type === "apiKey" ? `${user.email} via key ${principal.keyName}` : user.email;
      const deployment = queueDeploy(deps, {
        serviceId: svc.id,
        trigger: principal.type === "apiKey" ? "api" : "manual",
        actor,
        triggeredBy: user.id,
        uploadId: id,
      });
      return { uploadId: id, sizeBytes: size, deployment: toDeployment(deps.db, deployment) };
    } catch (error) {
      if (error instanceof OpError) return fail(error);
      deps.logger.error({ err: error }, "upload failed");
      return fail(new OpError("INTERNAL", "The upload failed."));
    }
  });
}

/** Archives a service keeps: the newest ones, plus any a deployment still builds from. */
const keptUploads = 2;

/** Older archives are never deployed again (deploys take the newest); without this each one stays on disk until the service goes. */
async function pruneUploads(deps: Pick<Deps, "db">, serviceId: string, dir: string): Promise<void> {
  const rows = deps.db
    .select({ id: sourceUploads.id })
    .from(sourceUploads)
    .where(eq(sourceUploads.serviceId, serviceId))
    .orderBy(desc(sourceUploads.createdAt))
    .all();
  const busy = new Set(
    deps.db
      .select({ id: deployments.uploadId })
      .from(deployments)
      .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, ["queued", "building"])))
      .all()
      .flatMap((r) => (r.id ? [r.id] : [])),
  );
  const stale = rows.slice(keptUploads).filter((r) => !busy.has(r.id));
  if (stale.length === 0) return;
  deps.db
    .delete(sourceUploads)
    .where(
      inArray(
        sourceUploads.id,
        stale.map((r) => r.id),
      ),
    )
    .run();
  await Promise.all(stale.map((r) => rm(join(dir, `${r.id}.tar.gz`), { force: true }).catch(() => undefined)));
}
