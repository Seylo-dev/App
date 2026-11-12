// AWS Signature Version 4 query authentication ("presigned URLs") for the
// S3 requests a node makes during a backup or restore. The panel keeps the
// destination's keys and hands a node one signed URL per request (see
// signing.ts), so the node moves the bytes straight to the bucket without
// ever holding a key that reaches other services' backups.
//
// The few steps a node cannot be given a URL for (the multipart create,
// complete and abort POST/DELETE requests, which not every provider takes
// presigned) the panel makes itself with header signing (signedRequest).
//
// Where the requests go is address.ts bucketAddress, the same answer the
// panel's own requests through Bun's S3 client get (storage.ts). Test
// vectors from minio-go's own signer are in
// test/fixtures/s3-presign-vectors.json.

import { createHash, createHmac } from "node:crypto";
import { type AddressConfig, bucketAddress, signingRegion } from "./address";
import type { StorageConfig } from "./storage";

export type SignedMethod = "GET" | "PUT" | "POST" | "DELETE";

export interface PresignRequest {
  method: SignedMethod;
  /** The full object key, or null for a bucket-level request (ListObjectsV2). */
  key: string | null;
  /** Extra query parameters (uploads, partNumber, uploadId, list-type, prefix, ...). */
  query?: Record<string, string>;
  /** Seconds the URL stays valid (1 to 604800). */
  expiresIn: number;
  now?: Date;
}

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~ is %XX (UTF-8). */
function encode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

/** 20130524T000000Z */
function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** The origin and canonical (already encoded) path of a key in the destination. */
export function storageTarget(config: AddressConfig, key: string | null): { origin: string; path: string } {
  const address = bucketAddress(config);
  const object = key ? encode(key, true) : "";
  return { origin: address.origin, path: address.virtualHosted ? `/${object}` : `/${encode(config.bucket)}/${object}` };
}

/** The canonical query string: encoded keys and values, sorted by key. */
function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

interface RawRequest {
  method: string;
  /** scheme://host[:port] */
  origin: string;
  /** The encoded path, starting with "/". */
  path: string;
  query: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

export interface RawPresign extends RawRequest {
  expiresIn: number;
}

/** The signature of a canonical request (SigV4, service s3). */
function signature(input: RawRequest, date: string, canonicalRequest: string): string {
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${input.secretAccessKey}`, day);
  for (const part of [input.region, "s3", "aws4_request"]) key = hmac(key, part);
  return createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
}

const scopeOf = (input: RawRequest, date: string) => `${date.slice(0, 8)}/${input.region}/s3/aws4_request`;

/** SigV4 query signing of one request with only the host header signed and an unsigned payload. */
export function presignRaw(input: RawPresign): string {
  const date = amzDate(input.now);
  const query = canonicalQuery({
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scopeOf(input, date)}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(input.expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const host = new URL(input.origin).host;
  const canonicalRequest = [input.method, input.path, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  return `${input.origin}${input.path}?${query}&X-Amz-Signature=${signature(input, date, canonicalRequest)}`;
}

export interface RawHeaderSigned extends RawRequest {
  body: string;
}

/** SigV4 header signing (Authorization) of a request the panel sends itself, its payload hashed. */
export function signHeadersRaw(input: RawHeaderSigned): { url: string; headers: Record<string, string> } {
  const date = amzDate(input.now);
  const query = canonicalQuery(input.query);
  const host = new URL(input.origin).host;
  const payload = sha256Hex(input.body);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [input.method, input.path, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scopeOf(input, date)}, SignedHeaders=${signedHeaders}, Signature=${signature(input, date, canonicalRequest)}`;
  return {
    url: `${input.origin}${input.path}${query ? `?${query}` : ""}`,
    headers: { authorization, "x-amz-content-sha256": payload, "x-amz-date": date },
  };
}

/** A presigned URL for one request on the destination. */
export function presign(config: StorageConfig, request: PresignRequest): string {
  if (!Number.isInteger(request.expiresIn) || request.expiresIn < 1 || request.expiresIn > 604800) {
    throw new Error("expiresIn must be 1 to 604800 seconds");
  }
  const target = storageTarget(config, request.key);
  return presignRaw({
    method: request.method,
    origin: target.origin,
    path: target.path,
    query: request.query ?? {},
    region: signingRegion(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    expiresIn: request.expiresIn,
    now: request.now ?? new Date(),
  });
}

/** A request the panel makes on the destination with its own keys (the multipart create, complete and abort steps). */
export function signedRequest(
  config: StorageConfig,
  request: { method: SignedMethod; key: string | null; query?: Record<string, string>; body?: string; now?: Date },
): { url: string; headers: Record<string, string> } {
  const target = storageTarget(config, request.key);
  return signHeadersRaw({
    method: request.method,
    origin: target.origin,
    path: target.path,
    query: request.query ?? {},
    region: signingRegion(config),
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    body: request.body ?? "",
    now: request.now ?? new Date(),
  });
}
