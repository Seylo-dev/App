// S3-compatible storage from the panel's side: the destination as agents
// get it (secret opened), the connection test (write, read, delete a small
// object) and deleting a backup object by hand. Uploads and downloads of
// backups themselves go straight from the node to the bucket.

import type { MessageInitShape } from "@bufbuild/protobuf";
import type { BackupDestinationSchema } from "@seylo/proto";
import type { backupDestinations } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";

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

export function protoDestination(config: StorageConfig): MessageInitShape<typeof BackupDestinationSchema> {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    prefix: config.pathPrefix,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    pathStyle: config.pathStyle,
  };
}

function client(config: StorageConfig) {
  return new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region || "auto",
    virtualHostedStyle: !config.pathStyle,
  });
}

function objectKey(config: StorageConfig, key: string): string {
  const prefix = config.pathPrefix.replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
}

export interface TestResult {
  ok: boolean;
  failedStep: "connect" | "auth" | "write" | "read" | "delete" | null;
  message: string;
  latencyMs: number | null;
}

const authCodes = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken", "Forbidden"]);

/** "connect" for network failures, "auth" for refused keys, else the step itself. */
function classify(error: unknown, step: "write" | "read" | "delete"): { step: TestResult["failedStep"]; message: string } {
  const e = error as { code?: string; name?: string; message?: string };
  const code = e.code ?? "";
  if (authCodes.has(code) || /\b403\b/.test(e.message ?? "")) {
    return { step: "auth", message: "The bucket refused the keys. Check the access key, secret and the key's permissions on this bucket." };
  }
  if (code === "NoSuchBucket") return { step: "auth", message: "The bucket does not exist at this endpoint." };
  if (
    /ConnectionRefused|ECONNREFUSED|ENOTFOUND|FailedToOpenSocket|ConnectionClosed|timed? ?out|ETIMEDOUT|UNABLE_TO_VERIFY|CERT/i.test(
      `${code} ${e.name} ${e.message}`,
    )
  ) {
    return { step: "connect", message: "Could not reach the endpoint. Check the URL and that it is reachable from the panel." };
  }
  const detail = code ? ` (${code})` : "";
  return { step, message: `The ${step} step failed${detail}.` };
}

/** Writes, reads back and deletes a small object. Never throws. */
export async function testStorage(config: StorageConfig): Promise<TestResult> {
  const started = performance.now();
  const s3 = client(config);
  const key = objectKey(config, `.seylo-test-${crypto.randomUUID()}`);
  const body = `connection test ${new Date().toISOString()}`;
  const steps: ["write" | "read" | "delete", () => Promise<void>][] = [
    [
      "write",
      async () => {
        await s3.write(key, body);
      },
    ],
    [
      "read",
      async () => {
        const back = await s3.file(key).text();
        if (back !== body) throw Object.assign(new Error("read back different bytes"), { code: "Mismatch" });
      },
    ],
    [
      "delete",
      async () => {
        await s3.delete(key);
      },
    ],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      const failed = classify(error, step);
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

/** Deletes one backup object. The key is the full key the agent reported. */
export async function deleteObject(config: StorageConfig, key: string): Promise<void> {
  await client(config).delete(key);
}
