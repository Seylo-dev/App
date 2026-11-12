// Where a destination's S3 requests go: one answer for the presigned URLs
// nodes get and the multipart steps the panel signs (presign.ts), and for
// the panel's own requests through Bun's S3 client (storage.ts: the
// connection test, retention's list and delete, deleting a run's object).
// The two used to disagree: Bun's client was given the endpoint with
// virtualHostedStyle whenever the path-style switch was off, and Bun then
// keeps the endpoint host as it is and sends no bucket at all (R2 read the
// test write PUT /.seylo-test-... as CreateBucket and answered MalformedXML).
//
// Addressing follows minio-go's BucketLookupAuto, which the agent used with
// the keys before (go/internal/backup/store.go): virtual-hosted (the bucket
// in the host) only for AWS, Google and Aliyun endpoints, and never for a
// dotted bucket over https; path-style (/<bucket>/<key>) everywhere else or
// when the destination asks for it. AWS requests go to the region's
// dual-stack endpoint, as minio-go sends them. One addition: an endpoint
// whose host already starts with the bucket (https://backups.nyc3.
// digitaloceanspaces.com with bucket "backups") is used as it is, the bucket
// not added a second time, unless path-style is on. A path in the endpoint
// is ignored either way.

import { isIP } from "node:net";
import type { StorageConfig } from "./storage";

export type AddressConfig = Pick<StorageConfig, "endpoint" | "region" | "bucket" | "pathStyle">;

export interface BucketAddress {
  /** scheme://host[:port] every request on the bucket goes to (the bucket's own host when virtualHosted). */
  origin: string;
  /** The bucket is in the host and paths are /<key>; else paths are /<bucket>/<key>. */
  virtualHosted: boolean;
  /** The SigV4 signing region. */
  region: string;
}

const isAmazon = (host: string) => /(^|\.)s3([.-][a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/.test(host) || host === "s3-external-1.amazonaws.com";

function isVirtualHostEndpoint(url: URL, bucket: string): boolean {
  if (url.protocol === "https:" && bucket.includes(".")) return false;
  const host = url.hostname;
  return isAmazon(host) || host === "storage.googleapis.com" || host.endsWith("aliyuncs.com");
}

/** minio-go's host for an AWS endpoint: the region's dual-stack endpoint (us-east-1 for an unknown region). */
function amazonHost(region: string): string {
  if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) return "s3.dualstack.us-east-1.amazonaws.com";
  return `s3.dualstack.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

/** Signing region: the destination's, "auto" for R2, else us-east-1 (MinIO's default). */
export function signingRegion(config: Pick<StorageConfig, "endpoint" | "region">): string {
  if (config.region) return config.region;
  return /\.r2\.cloudflarestorage\.com$/.test(new URL(config.endpoint).hostname) ? "auto" : "us-east-1";
}

/** The host and addressing style of the destination's bucket. */
export function bucketAddress(config: AddressConfig): BucketAddress {
  const url = new URL(config.endpoint);
  const region = signingRegion(config);
  // Every AWS request goes to the region's dual-stack endpoint, except for
  // FIPS and PrivateLink endpoints, which are used as they are.
  if (isAmazon(url.hostname) && !url.hostname.includes("fips") && !url.hostname.includes("vpce")) {
    const host = amazonHost(region);
    if (!config.pathStyle && isVirtualHostEndpoint(url, config.bucket)) {
      return { origin: `${url.protocol}//${config.bucket}.${host}`, virtualHosted: true, region };
    }
    return { origin: `${url.protocol}//${host}`, virtualHosted: false, region };
  }
  if (!config.pathStyle && isIP(url.hostname) === 0 && url.hostname.startsWith(`${config.bucket}.`)) {
    return { origin: url.origin, virtualHosted: true, region };
  }
  if (!config.pathStyle && isVirtualHostEndpoint(url, config.bucket)) {
    return { origin: `${url.protocol}//${config.bucket}.${url.host}`, virtualHosted: true, region };
  }
  return { origin: url.origin, virtualHosted: false, region };
}

/** Options for Bun's S3 client that address the bucket as bucketAddress does. */
export function bunS3Options(config: StorageConfig): Bun.S3Options {
  const address = bucketAddress(config);
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    // With virtualHostedStyle Bun keeps the endpoint's host as it is and
    // sends /<key>, so the endpoint must already be the bucket's host;
    // without it Bun sends /<bucket>/<key>.
    endpoint: address.origin,
    virtualHostedStyle: address.virtualHosted,
    region: address.region,
  };
}
