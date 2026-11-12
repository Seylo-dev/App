// S3-compatible storage from the panel's side: the destination with its
// secret opened (for the panel's own requests and for signing nodes'
// requests, signing.ts), the connection test (write, read, delete a small
// object), retention's listing and deleting a backup object. Uploads and
// downloads of backups themselves go straight from the node to the bucket,
// with URLs the panel presigned; nodes never get the keys. Both address the
// bucket through address.ts bucketAddress, so they reach the same objects.
// Objects nodes wrote on a bucket host before 0.2.15 are looked for
// at their old address too (address.ts legacyKey).

import type { backupDestinations } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import { bucketAddress, bunS3Options, legacyKey } from "./address";
import { storageTarget } from "./presign";

export type DestinationRow = typeof backupDestinations.$inferSelect;

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export function storageConfig(secrets: SecretBox, row: DestinationRow): StorageConfig {
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathPrefix: row.pathPrefix,
    pathStyle: row.pathStyle,
    accessKeyId: row.accessKeyId,
    secretAccessKey: secrets.open(row.secretAccessKeySealed, "backup.destination") ?? "",
  };
}

function client(config: StorageConfig) {
  return new Bun.S3Client(bunS3Options(config));
}

function objectKey(config: StorageConfig, key: string): string {
  const prefix = config.pathPrefix.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
}

/** One request on the bucket as errors name it: method, URL and how the bucket was addressed. Never the keys. */
interface BucketRequest {
  method: "GET" | "PUT" | "DELETE";
  /** The object key, or null for ListObjectsV2. */
  key: string | null;
  prefix?: string;
}

function requestLine(config: StorageConfig, request: BucketRequest): string {
  const target = storageTarget(config, request.key);
  const query = request.key === null ? `?list-type=2&prefix=${encodeURIComponent(request.prefix ?? "")}` : "";
  const how = bucketAddress(config).virtualHosted ? "bucket in the host" : `bucket "${config.bucket}" in the path`;
  return `${request.method} ${target.origin}${target.path}${query} (${how})`;
}

/** Bun's message when the answer had no S3 error body. */
const noBodyMessage = "an unexpected error has occurred";

/** The provider's error code and message, keys blanked out, cut to a line. */
function providerError(config: StorageConfig, error: unknown): { code: string; message: string } {
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  let message = typeof e.message === "string" && e.message !== noBodyMessage ? e.message : "";
  for (const secret of [config.secretAccessKey, config.accessKeyId]) {
    if (secret.length >= 4) message = message.split(secret).join("[key]");
  }
  message = message.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (message.length > 200) message = `${message.slice(0, 200)}...`;
  return { code: code === "UnknownError" ? "" : code, message };
}

/** "PUT https://... (bucket ... in the path) failed with MalformedXML: <the provider's message>" */
function describeFailure(config: StorageConfig, request: BucketRequest, error: unknown): string {
  const { code, message } = providerError(config, error);
  return `${requestLine(config, request)} failed with ${code || "no S3 error code"}${message ? `: ${message}` : ""}`;
}

/** The error retention and deleteRun see: what failed on which request, Bun's error code kept. */
function requestError(config: StorageConfig, request: BucketRequest, error: unknown): Error {
  return Object.assign(new Error(describeFailure(config, request, error), { cause: error }), { code: (error as { code?: unknown }).code });
}

export interface TestResult {
  ok: boolean;
  failedStep: "connect" | "auth" | "write" | "read" | "delete" | null;
  message: string;
  latencyMs: number | null;
}

const authCodes = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "Forbidden"]);
/** Answers to a request the provider did not take as one on this bucket's objects (a CreateBucket, another bucket). */
const addressCodes = new Set([
  "MalformedXML",
  "InvalidBucketName",
  "InvalidURI",
  "MethodNotAllowed",
  "BucketAlreadyExists",
  "BucketAlreadyOwnedByYou",
  "TooManyBuckets",
]);
const regionCodes = new Set(["AuthorizationHeaderMalformed", "InvalidRegion", "IllegalLocationConstraintException"]);
const redirectCodes = new Set(["PermanentRedirect", "TemporaryRedirect"]);

/** "connect" for network failures, "auth" for refused keys or a missing bucket, else the step itself. */
function classify(
  config: StorageConfig,
  error: unknown,
  step: "write" | "read" | "delete",
  request: BucketRequest,
): { step: TestResult["failedStep"]; message: string } {
  const e = error as { code?: string; name?: string; message?: string };
  const code = e.code ?? "";
  const origin = bucketAddress(config).origin;
  if (authCodes.has(code) || /\b403\b/.test(e.message ?? "")) {
    return {
      step: "auth",
      message: `The bucket refused the keys: ${describeFailure(config, request, error)}. Check the access key, secret and the key's permissions on this bucket.`,
    };
  }
  if (code === "NoSuchBucket") {
    return {
      step: "auth",
      message: `The bucket "${config.bucket}" does not exist at ${origin}. ${describeFailure(config, request, error)}.`,
    };
  }
  if (
    /ConnectionRefused|ECONNREFUSED|ENOTFOUND|FailedToOpenSocket|ConnectionClosed|timed? ?out|ETIMEDOUT|UNABLE_TO_VERIFY|CERT/i.test(
      `${code} ${e.name} ${e.message}`,
    )
  ) {
    return {
      step: "connect",
      message: `Could not reach ${origin} (${code || e.name || "network error"}). Check the URL and that it is reachable from the panel.`,
    };
  }
  if (code === "Mismatch") {
    return { step, message: `The read step failed: ${requestLine(config, request)} answered with other bytes than the test wrote.` };
  }
  let hint = "";
  if (addressCodes.has(code))
    hint = " The bucket did not take it as a request on its objects: check the endpoint, the bucket name and the path-style switch.";
  else if (regionCodes.has(code)) hint = ` Check the region (the panel signed for "${bucketAddress(config).region}"; R2 takes "auto").`;
  else if (redirectCodes.has(code)) hint = " The bucket is served from another endpoint or region.";
  return { step, message: `The ${step} step failed: ${describeFailure(config, request, error)}.${hint}` };
}

/** Writes, reads back and deletes a small object. Never throws. */
export async function testStorage(config: StorageConfig): Promise<TestResult> {
  const started = performance.now();
  const s3 = client(config);
  const key = objectKey(config, `.seylo-test-${crypto.randomUUID()}`);
  const body = `connection test ${new Date().toISOString()}`;
  const steps: ["write" | "read" | "delete", BucketRequest, () => Promise<void>][] = [
    [
      "write",
      { method: "PUT", key },
      async () => {
        await s3.write(key, body);
      },
    ],
    [
      "read",
      { method: "GET", key },
      async () => {
        const back = await s3.file(key).text();
        if (back !== body) throw Object.assign(new Error("read back different bytes"), { code: "Mismatch" });
      },
    ],
    [
      "delete",
      { method: "DELETE", key },
      async () => {
        await s3.delete(key);
      },
    ],
  ];
  for (const [step, request, run] of steps) {
    try {
      await run();
    } catch (error) {
      const failed = classify(config, error, step, request);
      return { ok: false, failedStep: failed.step, message: failed.message, latencyMs: null };
    }
  }
  return {
    ok: true,
    failedStep: null,
    message: "Wrote, read and deleted a test object.",
    latencyMs: Math.round(performance.now() - started),
  };
}

/** Deletes one object, the key as it is in the bucket. */
export async function deleteObject(config: StorageConfig, key: string): Promise<void> {
  try {
    await client(config).delete(key);
  } catch (error) {
    throw requestError(config, { method: "DELETE", key }, error);
  }
}

/**
 * Deletes a run's backup object. The key is the full key the agent
 * reported, checked by ownObjectKey; on a bucket host the object may still
 * be at its address from before 0.2.15 (address.ts legacyKey), so
 * that one goes too (a delete of a missing key succeeds).
 */
export async function deleteRunObject(config: StorageConfig, key: string): Promise<void> {
  await deleteObject(config, key);
  const legacy = legacyKey(config, key);
  if (legacy) await deleteObject(config, legacy);
}

/**
 * The key a run's object is at, for presigning its download: the key the
 * agent reported, or on a bucket host its address from before 0.2.15
 * (address.ts legacyKey) when only that one exists. When the bucket cannot
 * tell (an error, or no answer within `timeoutMs`), the reported key: the
 * node's download then fails with the bucket's own answer.
 */
export async function storedKey(config: StorageConfig, key: string, timeoutMs = 15_000): Promise<string> {
  const legacy = legacyKey(config, key);
  if (!legacy) return key;
  const s3 = client(config);
  const lookup = (async () => {
    if (await s3.exists(key)) return key;
    return (await s3.exists(legacy)) ? legacy : key;
  })().catch(() => key);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(key), timeoutMs);
  });
  try {
    return await Promise.race([lookup, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every key under `prefix` (ListObjectsV2, all pages). */
export async function listObjects(config: StorageConfig, prefix: string): Promise<string[]> {
  const s3 = client(config);
  const keys: string[] = [];
  let continuationToken: string | undefined;
  for (let page = 0; page < 1000; page++) {
    let result: Awaited<ReturnType<typeof s3.list>>;
    try {
      result = await s3.list({ prefix, continuationToken });
    } catch (error) {
      throw requestError(config, { method: "GET", key: null, prefix }, error);
    }
    for (const object of result.contents ?? []) if (object.key.startsWith(prefix)) keys.push(object.key);
    if (!result.isTruncated || !result.nextContinuationToken) return keys;
    continuationToken = result.nextContinuationToken;
  }
  throw new Error(`listing ${prefix}: more than 1000 pages`);
}
