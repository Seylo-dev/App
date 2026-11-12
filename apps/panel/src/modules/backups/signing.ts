// Signed backups: nodes never get a backup destination's keys. RunBackup
// and RestoreBackup carry the destination without them and a signing id
// (the run's id); the node asks PanelService.SignBackupRequests for each S3
// step and the panel serves only what that run needs:
//
//   backup   for the run's own object (<prefix>/<service id>/<backup id>/
//            <time>-<run id><ext>): presigned PUT, UploadPart and DELETE
//            URLs, and the multipart create, complete and abort steps,
//            which the panel makes itself (not every provider takes POST
//            presigned). Retention (keepLast) is the panel's too
//            (pruneBackups), so a node never lists or deletes others.
//   restore  a presigned GET of the restored backup's object.
//
// Only while the run is running, only for the node it runs on. So a
// compromised node reaches the backups of its own runs, not every backup in
// the bucket.

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  type BackupDestinationSchema,
  BackupStorageOp,
  type SignBackupRequestsRequest,
  type SignedStorageRequest,
  SignedStorageRequestSchema,
  StatusCode,
} from "@seylo/proto";
import { eq } from "drizzle-orm";
import { PanelServiceError } from "../../agent-hub/panel-service-types";
import type { PanelDb } from "../../db/client";
import { backupDestinations, backupRuns } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { serviceNodes } from "../domains/lookup";
import { presign, type SignedMethod, signedRequest } from "./presign";
import { type DestinationRow, type StorageConfig, storageConfig, storedKey } from "./storage";

/** Agents that take a destination without keys and ask the panel to sign (BackupDestination.signing_id). */
export const signedBackupsCapability = "backup.signed.v1";
/** How long a signed URL stays valid; the node asks right before each request. */
export const signedUrlSeconds = 3600;
/** Requests per SignBackupRequests call. */
export const maxSignedRequests = 32;
/** Backup id of one-off runs (runs.ts manualBackupId). */
const manualBackupId = "manual";
const objectExtensions = [".clickhouse.zip", ".tar.gz", ".sql.gz", ".archive.gz", ".rdb.gz", ".dump"];
const keyTime = /^\d{8}T\d{6}Z$/;
const maxUploadId = 2048;
/** S3's limit on the parts of one multipart upload. */
const maxParts = 10000;

/** The destination as an agent gets it: no keys, the run to sign for. */
export function signedDestination(row: DestinationRow, signingId: string): MessageInitShape<typeof BackupDestinationSchema> {
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.pathPrefix,
    pathStyle: row.pathStyle,
    signingId,
  };
}

/**
 * The folder a backup's objects go to, as the agent builds it
 * (go/internal/backup/keys.go backupDir: path.Join of the trimmed prefix,
 * the service id and the backup id, ending in "/").
 */
export function backupFolder(prefix: string, serviceId: string, backupId: string): string {
  const parts = prefix.split("/").filter((p) => p !== "" && p !== ".");
  return `${[...parts, serviceId, backupId].join("/")}/`;
}

/** Whether `name` (a key inside a folder) is an object the agent writes: <time>-<run id><ext>. */
function backupObjectName(name: string): boolean {
  if (name.includes("/") || !keyTime.test(name.slice(0, 16)) || name[16] !== "-") return false;
  return objectExtensions.some((ext) => name.endsWith(ext) && name.length > 17 + ext.length);
}

const denied = (message: string) => new PanelServiceError(StatusCode.PERMISSION_DENIED, message);
const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnescape = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The time the panel waits for the bucket on a step it makes itself. */
const bucketTimeoutMs = 60_000;

/** One step the panel makes on the bucket with its keys; UNAVAILABLE with the bucket's error code when it fails. */
async function bucketStep(
  config: StorageConfig,
  step: { method: SignedMethod; key: string; query: Record<string, string>; body?: string; what: string },
): Promise<string> {
  const signed = signedRequest(config, step);
  let response: Response;
  try {
    response = await fetch(signed.url, {
      method: step.method,
      headers: step.body ? { ...signed.headers, "content-type": "application/xml" } : signed.headers,
      body: step.body || undefined,
      signal: AbortSignal.timeout(bucketTimeoutMs),
      redirect: "manual",
    });
  } catch {
    throw new PanelServiceError(StatusCode.UNAVAILABLE, `The panel could not reach the bucket to ${step.what}.`);
  }
  const text = await response.text().catch(() => "");
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  // CompleteMultipartUpload can answer 200 with an error in the body.
  if (!response.ok || (code && /<Error>/.test(text))) {
    if (step.method === "DELETE" && (response.status === 404 || code === "NoSuchUpload")) return text;
    throw new PanelServiceError(
      StatusCode.UNAVAILABLE,
      `The bucket refused to ${step.what}${code ? ` (${code})` : ` (HTTP ${response.status})`}.`,
    );
  }
  return text;
}

interface Presigned {
  method: SignedMethod;
  key: string;
  query: Record<string, string>;
}

type Step = { presign: Presigned } | { bucket: () => Promise<{ uploadId?: string }> };

function ownObjectStep(config: StorageConfig, r: SignBackupRequestsRequest["requests"][number]): Step {
  const key = r.key;
  const needsUpload =
    r.op === BackupStorageOp.UPLOAD_PART || r.op === BackupStorageOp.COMPLETE_MULTIPART || r.op === BackupStorageOp.ABORT_MULTIPART;
  if (needsUpload && (!r.uploadId || r.uploadId.length > maxUploadId)) throw denied("This request needs the multipart upload id.");
  const uploadId = r.uploadId;
  switch (r.op) {
    case BackupStorageOp.PUT:
      return { presign: { method: "PUT", key, query: {} } };
    case BackupStorageOp.UPLOAD_PART:
      if (!Number.isInteger(r.partNumber) || r.partNumber < 1 || r.partNumber > maxParts) throw denied("Part numbers go from 1 to 10000.");
      return { presign: { method: "PUT", key, query: { partNumber: String(r.partNumber), uploadId } } };
    case BackupStorageOp.DELETE:
      return { presign: { method: "DELETE", key, query: {} } };
    case BackupStorageOp.CREATE_MULTIPART:
      return {
        bucket: async () => {
          const text = await bucketStep(config, { method: "POST", key, query: { uploads: "" }, what: "start the upload" });
          const id = /<UploadId>([^<]+)<\/UploadId>/.exec(text)?.[1];
          if (!id) throw new PanelServiceError(StatusCode.UNAVAILABLE, "The bucket answered the upload start without an upload id.");
          return { uploadId: xmlUnescape(id) };
        },
      };
    case BackupStorageOp.COMPLETE_MULTIPART: {
      const parts = r.parts;
      if (parts.length === 0 || parts.length > maxParts) throw denied("A finished upload has 1 to 10000 parts.");
      parts.forEach((part, i) => {
        if (part.partNumber !== i + 1 || !part.etag || part.etag.length > 256)
          throw denied("The parts must be numbered 1, 2, 3, ... with their ETags.");
      });
      const body = `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
      return {
        bucket: async () => {
          await bucketStep(config, { method: "POST", key, query: { uploadId }, body, what: "finish the upload" });
          return {};
        },
      };
    }
    case BackupStorageOp.ABORT_MULTIPART:
      return {
        bucket: async () => {
          await bucketStep(config, { method: "DELETE", key, query: { uploadId }, what: "abort the upload" });
          return {};
        },
      };
    default:
      throw denied("The panel does not sign this request for a backup.");
  }
}

export interface SigningDeps {
  db: PanelDb;
  secrets: SecretBox;
}

/**
 * PanelService.SignBackupRequests for one running backup or restore on
 * `nodeId`. Every request is checked before any is served: one outside
 * what the run needs refuses the whole call (PERMISSION_DENIED).
 */
export async function signBackupRequests(
  deps: SigningDeps,
  nodeId: string,
  request: Pick<SignBackupRequestsRequest, "signingId" | "requests">,
  now = new Date(),
): Promise<SignedStorageRequest[]> {
  if (request.requests.length === 0) return [];
  if (request.requests.length > maxSignedRequests) {
    throw new PanelServiceError(StatusCode.INVALID_ARGUMENT, `At most ${maxSignedRequests} requests per call.`);
  }
  const run = request.signingId ? deps.db.select().from(backupRuns).where(eq(backupRuns.id, request.signingId)).get() : undefined;
  if (run?.status !== "running") throw denied("That backup or restore is not running.");

  let destination: DestinationRow | undefined;
  let target: StorageConfig | undefined;
  let steps: Step[];
  if (run.kind === "backup") {
    if (run.nodeId !== nodeId) throw denied("That backup runs on another node.");
    destination = run.destinationId
      ? deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, run.destinationId)).get()
      : undefined;
    if (!destination) throw denied("The backup's destination was deleted.");
    const folder = backupFolder(destination.pathPrefix, run.serviceId, run.policyId ?? manualBackupId);
    const config = storageConfig(deps.secrets, destination);
    target = config;
    steps = request.requests.map((r) => {
      const name = r.key.startsWith(folder) ? r.key.slice(folder.length) : null;
      const own = name !== null && backupObjectName(name) && objectExtensions.some((ext) => name.slice(16) === `-${run.id}${ext}`);
      if (!own) throw denied("The panel signs only requests on this backup's own object.");
      return ownObjectStep(config, r);
    });
  } else {
    // A restore runs on the service's first node (runs.ts runRestore).
    if (serviceNodes(deps.db, run.serviceId)[0]?.id !== nodeId) throw denied("That restore runs on another node.");
    const source = run.sourceRunId ? deps.db.select().from(backupRuns).where(eq(backupRuns.id, run.sourceRunId)).get() : undefined;
    destination = source?.destinationId
      ? deps.db.select().from(backupDestinations).where(eq(backupDestinations.id, source.destinationId)).get()
      : undefined;
    if (!source?.objectKey || source.serviceId !== run.serviceId || !destination) throw denied("The backup to restore is gone.");
    const key = source.objectKey;
    for (const r of request.requests) {
      if (r.op !== BackupStorageOp.GET || r.key !== key) throw denied("The panel signs only the download of the restored backup.");
    }
    // On a bucket host a backup from before 0.2.15 may be at its old
    // address (address.ts legacyKey): the node gets the one that exists.
    target = storageConfig(deps.secrets, destination);
    const stored = await storedKey(target, key);
    steps = request.requests.map(() => ({ presign: { method: "GET", key: stored, query: {} } }));
  }

  const config = target ?? storageConfig(deps.secrets, destination);
  const out: SignedStorageRequest[] = [];
  for (const step of steps) {
    if ("presign" in step) {
      const { method, key, query } = step.presign;
      out.push(
        create(SignedStorageRequestSchema, { method, url: presign(config, { method, key, query, expiresIn: signedUrlSeconds, now }) }),
      );
    } else {
      out.push(create(SignedStorageRequestSchema, await step.bucket()));
    }
  }
  return out;
}

/**
 * The objects retention deletes from a backup's folder: everything the
 * agent wrote directly in it except the newest `keep` (by the time in the
 * key), like go/internal/backup/keys.go expired. keep 0 deletes nothing.
 */
export function expiredObjects(folder: string, keys: string[], keep: number): string[] {
  if (keep <= 0) return [];
  const ours = keys.filter((k) => k.startsWith(folder) && backupObjectName(k.slice(folder.length))).sort();
  return ours.length <= keep ? [] : ours.slice(0, ours.length - keep);
}
