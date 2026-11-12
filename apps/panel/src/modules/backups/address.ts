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
// dual-stack endpoint, as minio-go sends them. A path in the endpoint is
// ignored either way.
//
// One addition: an endpoint that is already a bucket's own host at a
// provider known to serve buckets that way (https://backups.nyc3.
// digitaloceanspaces.com with bucket "backups", see bucketHostServices) is
// used as it is, the bucket not added again in the path, unless path-style
// is on. Any other host that happens to start with "<bucket>." (MinIO behind
// https://backups.example.com) stays path-style: that name is the server's,
// not the bucket's. Before 0.2.15 nodes sent /<bucket>/<key> to such a bucket
// host too, so the objects they wrote then sit under a "<bucket>/" folder
// inside the bucket (legacyKey).

import type { StorageConfig } from "./storage";

export type AddressConfig = Pick<StorageConfig, "endpoint" | "region" | "bucket" | "pathStyle">;

export interface BucketAddress {
  /** scheme://host[:port] every request on the bucket goes to (the bucket's own host when virtualHosted). */
  origin: string;
  /** The bucket is in the host and paths are /<key>; else paths are /<bucket>/<key>. */
  virtualHosted: boolean;
  /** The endpoint was already the bucket's own host at a known provider, used as it is. */
  bucketHost: boolean;
  /** The SigV4 signing region. */
  region: string;
}

const isAmazon = (host: string) => /(^|\.)s3([.-][a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/.test(host) || host === "s3-external-1.amazonaws.com";

/**
 * Endpoint hosts of providers that serve a bucket at <bucket>.<that host>,
 * so a host of that shape is a bucket's own host and nothing else. AWS is
 * isAmazon (its regular endpoints never get here, FIPS and PrivateLink
 * ones do).
 */
const bucketHostServices: RegExp[] = [
  /^[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/, // Cloudflare R2: <account id>[.<jurisdiction>]
  /^[a-z0-9-]+\.digitaloceanspaces\.com$/, // DigitalOcean Spaces: <region>
  /^oss-[a-z0-9-]+\.aliyuncs\.com$/, // Alibaba Cloud OSS: oss-<region>[-internal]
  /^storage\.googleapis\.com$/, // Google Cloud Storage
  /^s3\.[a-z0-9-]+\.backblazeb2\.com$/, // Backblaze B2: s3.<region>
  /^s3(\.[a-z0-9-]+)?\.wasabisys\.com$/, // Wasabi: s3[.<region>]
  /^[a-z0-9-]+\.linodeobjects\.com$/, // Akamai (Linode) Object Storage: <region>
  /^s3\.[a-z0-9-]+\.scw\.cloud$/, // Scaleway: s3.<region>
  /^[a-z0-9-]+\.your-objectstorage\.com$/, // Hetzner: <location>
];

/** Whether `host` is <bucket>.<a known provider's endpoint host>. */
function isBucketHost(host: string, bucket: string): boolean {
  if (!host.startsWith(`${bucket}.`)) return false;
  const service = host.slice(bucket.length + 1);
  return isAmazon(service) || bucketHostServices.some((pattern) => pattern.test(service));
}

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
  const address = (origin: string, virtualHosted: boolean, bucketHost = false) => ({ origin, virtualHosted, bucketHost, region });
  // Every AWS request goes to the region's dual-stack endpoint, except for
  // FIPS and PrivateLink endpoints, which are used as they are.
  if (isAmazon(url.hostname) && !url.hostname.includes("fips") && !url.hostname.includes("vpce")) {
    const host = amazonHost(region);
    if (!config.pathStyle && isVirtualHostEndpoint(url, config.bucket)) return address(`${url.protocol}//${config.bucket}.${host}`, true);
    return address(`${url.protocol}//${host}`, false);
  }
  if (config.pathStyle) return address(url.origin, false);
  if (isBucketHost(url.hostname, config.bucket)) return address(url.origin, true, true);
  if (isVirtualHostEndpoint(url, config.bucket)) return address(`${url.protocol}//${config.bucket}.${url.host}`, true);
  return address(url.origin, false);
}

/**
 * Where `key` (an object key or a folder) was written before 0.2.15
 * on a destination whose endpoint is the bucket's own host: nodes then sent
 * /<bucket>/<key> to that host, which is the key "<bucket>/<key>" inside
 * the bucket. Null for every other destination, whose addressing is the
 * same as then, and for the bucket hosts nodes then put the bucket in front
 * of a second time (Aliyun, AWS FIPS and PrivateLink), which wrote nothing.
 */
export function legacyKey(config: AddressConfig, key: string): string | null {
  if (!bucketAddress(config).bucketHost || isVirtualHostEndpoint(new URL(config.endpoint), config.bucket)) return null;
  return `${config.bucket}/${key}`;
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
