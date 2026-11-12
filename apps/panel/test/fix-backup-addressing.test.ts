// The panel's own S3 requests (the connection test, retention's list and
// delete, deleting a run's object) address the bucket exactly as the URLs
// nodes get (presign.ts storageTarget): path-style unless the endpoint is a
// virtual-host one. Before, Bun's client got virtualHostedStyle whenever
// the path-style switch was off and then sent no bucket at all: R2 read the
// test write PUT /.seylo-test-... as CreateBucket (MalformedXML), deletes
// went to a bucket named after the key's first folder, the listing became
// ListBuckets.
//
// An endpoint that is a bucket's own host is used as it is only at the
// providers known to serve buckets that way (R2, Spaces, ...): a MinIO
// behind https://backups.example.com with bucket "backups" stays
// path-style, as the nodes' URLs always were for it. Objects nodes wrote on
// a bucket host before 0.2.15 sit under "<bucket>/" in the bucket
// (they sent /<bucket>/<key> to it); restore, deleteRun and retention find
// them there.
//
// The fake provider is an HTTP proxy (HTTP_PROXY, http:// endpoints), so it
// sees the host each request was for: AWS and R2 host names included.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { backups as backupOps } from "@seylo/ops";
import { BackupStorageOp, BackupStorageRequestSchema } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { backupDestinations, backupPolicies, backupRuns } from "../src/db/schema";
import { bunS3Options, legacyKey } from "../src/modules/backups/address";
import { presign, storageTarget } from "../src/modules/backups/presign";
import { pruneBackups } from "../src/modules/backups/runs";
import { signBackupRequests } from "../src/modules/backups/signing";
import { deleteObject, listObjects, type StorageConfig, storedKey, testStorage } from "../src/modules/backups/storage";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

const accessKeyId = "AKIDEXAMPLE";
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
/** A Cloudflare account id (32 hex digits). */
const account = "0123456789abcdef0123456789abcdef";

// An S3 provider. Like the real ones, the hosts in `services` also serve
// each bucket at <bucket>.<host> (virtual-hosted: the path is the key);
// every other host, and those hosts themselves, are path-style
// (/<bucket>/<key>), like MinIO whatever its host is called. A path with
// no bucket in it is a request on the service (PUT = CreateBucket, whose
// body must be XML; GET / = ListBuckets), as R2 and AWS read them.
const services = new Set([
  `${account}.r2.cloudflarestorage.com`,
  "s3.dualstack.eu-central-1.amazonaws.com",
  "s3.dualstack.us-east-1.amazonaws.com",
  "nyc3.digitaloceanspaces.com",
]);
const buckets = new Map<string, Map<string, string>>();
const requests: { line: string; region: string }[] = [];
let failNext: { status: number; code: string; message: string } | null = null;

const xmlError = (status: number, code: string, message: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });

async function provider(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const region = /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\/aws4_request/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  requests.push({ line: `${req.method} ${host}${url.pathname}${url.search}`, region });
  if (failNext) {
    const answer = failNext;
    failNext = null;
    return xmlError(answer.status, answer.code, answer.message);
  }
  let bucket: string;
  let key: string;
  const dot = host.indexOf(".");
  if (dot > 0 && services.has(host.slice(dot + 1))) {
    bucket = host.slice(0, dot);
    key = decodeURIComponent(url.pathname.slice(1));
  } else {
    const rest = url.pathname.slice(1);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      if (req.method === "PUT")
        return xmlError(400, "MalformedXML", "The XML you provided was not well formed or did not validate against our published schema.");
      if (req.method === "GET" && rest === "") {
        const names = [...buckets.keys()].map((b) => `<Bucket><Name>${b}</Name></Bucket>`).join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets>${names}</Buckets></ListAllMyBucketsResult>`,
        );
      }
      return xmlError(404, "NoSuchBucket", "The specified bucket does not exist.");
    }
    bucket = rest.slice(0, slash);
    key = decodeURIComponent(rest.slice(slash + 1));
  }
  const objects = buckets.get(bucket);
  if (!objects) return xmlError(404, "NoSuchBucket", "The specified bucket does not exist.");
  if (req.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const contents = [...objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
    );
  }
  if (req.method === "PUT") {
    objects.set(key, await req.text());
    return new Response("");
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const body = objects.get(key);
    if (body === undefined)
      return req.method === "HEAD" ? new Response(null, { status: 404 }) : xmlError(404, "NoSuchKey", "The specified key does not exist.");
    return new Response(req.method === "HEAD" ? null : body);
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  return xmlError(405, "MethodNotAllowed", "no");
}

let proxy: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  // On 127.0.0.1, not a wildcard listener (see fix-backup-signing.test.ts).
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: provider });
});
afterAll(() => proxy.stop(true));
beforeEach(() => {
  buckets.clear();
  for (const name of ["seylo-backups", "backups"]) buckets.set(name, new Map());
  requests.length = 0;
  failNext = null;
});

const proxyVars = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;

/** Runs `fn` with every plain-http request sent to the fake provider. */
async function viaProvider<T>(fn: () => Promise<T>): Promise<T> {
  const saved = proxyVars.map((name) => [name, process.env[name]] as const);
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
  process.env.http_proxy = process.env.HTTP_PROXY;
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const lines = () => requests.map((r) => r.line.replace(/\.seylo-test-[0-9a-f-]{36}/, ".seylo-test-ID"));

interface Case {
  name: string;
  config: Omit<StorageConfig, "accessKeyId" | "secretAccessKey">;
  /** The host and the path every object key follows. */
  host: string;
  base: string;
  bucket: string;
  region: string;
  /** The endpoint is the bucket's own host: objects from before 0.2.15 are under "<bucket>/". */
  legacy?: boolean;
}

const cases: Case[] = [
  {
    // The owner's destination: R2, "Use path-style URLs" off, no folder.
    name: "R2 with the path-style switch off",
    config: {
      endpoint: `http://${account}.r2.cloudflarestorage.com`,
      region: "auto",
      bucket: "seylo-backups",
      pathPrefix: "",
      pathStyle: false,
    },
    host: `${account}.r2.cloudflarestorage.com`,
    base: "/seylo-backups/",
    bucket: "seylo-backups",
    region: "auto",
  },
  {
    name: "MinIO, path-style",
    config: { endpoint: "http://minio.internal:9000", region: "us-east-1", bucket: "backups", pathPrefix: "seylo", pathStyle: true },
    host: "minio.internal:9000",
    base: "/backups/",
    bucket: "backups",
    region: "us-east-1",
  },
  {
    // A MinIO (or Garage, SeaweedFS) whose host name starts with the
    // bucket's: the name is the server's, the bucket stays in the path.
    name: "MinIO at a host named like the bucket, the path-style switch off",
    config: { endpoint: "http://backups.example.test", region: "us-east-1", bucket: "backups", pathPrefix: "seylo", pathStyle: false },
    host: "backups.example.test",
    base: "/backups/",
    bucket: "backups",
    region: "us-east-1",
  },
  {
    name: "AWS S3: virtual-hosted on the region's dual-stack host",
    config: {
      endpoint: "http://s3.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      bucket: "seylo-backups",
      pathPrefix: "seylo",
      pathStyle: false,
    },
    host: "seylo-backups.s3.dualstack.eu-central-1.amazonaws.com",
    base: "/",
    bucket: "seylo-backups",
    region: "eu-central-1",
  },
  {
    name: "AWS S3 with the path-style switch on",
    config: {
      endpoint: "http://s3.eu-central-1.amazonaws.com",
      region: "eu-central-1",
      bucket: "seylo-backups",
      pathPrefix: "seylo",
      pathStyle: true,
    },
    host: "s3.dualstack.eu-central-1.amazonaws.com",
    base: "/seylo-backups/",
    bucket: "seylo-backups",
    region: "eu-central-1",
  },
  {
    name: "an R2 endpoint that is the bucket's own host",
    config: {
      endpoint: `http://seylo-backups.${account}.r2.cloudflarestorage.com`,
      region: "auto",
      bucket: "seylo-backups",
      pathPrefix: "seylo",
      pathStyle: false,
    },
    host: `seylo-backups.${account}.r2.cloudflarestorage.com`,
    base: "/",
    bucket: "seylo-backups",
    region: "auto",
    legacy: true,
  },
  {
    name: "a Spaces endpoint that is the bucket's own host",
    config: { endpoint: "http://backups.nyc3.digitaloceanspaces.com", region: "nyc3", bucket: "backups", pathPrefix: "", pathStyle: false },
    host: "backups.nyc3.digitaloceanspaces.com",
    base: "/",
    bucket: "backups",
    region: "nyc3",
    legacy: true,
  },
];

const withKeys = (c: Case): StorageConfig => ({ ...c.config, accessKeyId, secretAccessKey });
const caseNamed = (start: string) => cases.find((c) => c.name.startsWith(start)) as Case;
const folderOf = (c: Case) => (c.config.pathPrefix ? `${c.config.pathPrefix}/` : "");

describe("the panel's requests address the bucket as the nodes' URLs do", () => {
  test.each(cases.map((c) => [c.name, c]))("connection test: %s", async (_name, c) => {
    const result = await viaProvider(() => testStorage(withKeys(c)));
    expect(result).toMatchObject({ ok: true, failedStep: null });
    const key = `${folderOf(c)}.seylo-test-ID`;
    expect(lines()).toEqual([`PUT ${c.host}${c.base}${key}`, `GET ${c.host}${c.base}${key}`, `DELETE ${c.host}${c.base}${key}`]);
    expect(new Set(requests.map((r) => r.region))).toEqual(new Set([c.region]));
    expect(buckets.get(c.bucket)?.size).toBe(0);
  });

  test.each(cases.map((c) => [c.name, c]))("list and delete: %s", async (_name, c) => {
    const folder = `${folderOf(c)}svc/pol/`;
    const objects = buckets.get(c.bucket) as Map<string, string>;
    for (const name of ["20260101T030000Z-a.dump", "20260102T030000Z-b.dump"]) objects.set(`${folder}${name}`, "x");
    objects.set("elsewhere/20260101T030000Z-c.dump", "x");
    const listed = await viaProvider(() => listObjects(withKeys(c), folder));
    expect(listed).toEqual([`${folder}20260101T030000Z-a.dump`, `${folder}20260102T030000Z-b.dump`]);
    await viaProvider(() => deleteObject(withKeys(c), `${folder}20260101T030000Z-a.dump`));
    expect([...objects.keys()].sort()).toEqual(["elsewhere/20260101T030000Z-c.dump", `${folder}20260102T030000Z-b.dump`]);
    expect(lines()).toEqual([
      `GET ${c.host}${c.base}?list-type=2&prefix=${encodeURIComponent(folder)}`,
      `DELETE ${c.host}${c.base}${folder}20260101T030000Z-a.dump`,
    ]);
  });

  // Without the network: Bun's client, given bunS3Options, presigns the same
  // URL (host, path and signature) as presign.ts, for https endpoints too.
  test("Bun's client and presign.ts agree on every kind of endpoint", () => {
    const https: [string, Omit<StorageConfig, "accessKeyId" | "secretAccessKey" | "pathPrefix">][] = [
      ["R2", { endpoint: `https://${account}.r2.cloudflarestorage.com`, region: "auto", bucket: "seylo-backups", pathStyle: false }],
      [
        "R2 path-style",
        { endpoint: `https://${account}.r2.cloudflarestorage.com`, region: "auto", bucket: "seylo-backups", pathStyle: true },
      ],
      [
        "R2 bucket host",
        {
          endpoint: `https://seylo-backups.${account}.r2.cloudflarestorage.com`,
          region: "auto",
          bucket: "seylo-backups",
          pathStyle: false,
        },
      ],
      [
        "R2 bucket in the endpoint path",
        {
          endpoint: `https://${account}.r2.cloudflarestorage.com/seylo-backups`,
          region: "auto",
          bucket: "seylo-backups",
          pathStyle: false,
        },
      ],
      ["AWS", { endpoint: "https://s3.eu-central-1.amazonaws.com", region: "eu-central-1", bucket: "seylo-backups", pathStyle: false }],
      [
        "AWS bucket host",
        {
          endpoint: "https://seylo-backups.s3.eu-central-1.amazonaws.com",
          region: "eu-central-1",
          bucket: "seylo-backups",
          pathStyle: false,
        },
      ],
      ["AWS dotted bucket", { endpoint: "https://s3.amazonaws.com", region: "us-east-1", bucket: "my.dotted.bucket", pathStyle: false }],
      ["AWS FIPS", { endpoint: "https://s3-fips.us-east-1.amazonaws.com", region: "us-east-1", bucket: "seylo-backups", pathStyle: false }],
      ["Google", { endpoint: "https://storage.googleapis.com", region: "auto", bucket: "seylo-backups", pathStyle: false }],
      [
        "Aliyun bucket host",
        {
          endpoint: "https://seylo-backups.oss-cn-hangzhou.aliyuncs.com",
          region: "oss-cn-hangzhou",
          bucket: "seylo-backups",
          pathStyle: false,
        },
      ],
      ["MinIO", { endpoint: "https://minio.example.com:9443", region: "us-east-1", bucket: "backups", pathStyle: true }],
      ["MinIO, switch off", { endpoint: "https://minio.example.com:9443", region: "us-east-1", bucket: "backups", pathStyle: false }],
      ["IP address", { endpoint: "http://127.0.0.1:9000", region: "us-east-1", bucket: "127", pathStyle: false }],
      [
        "Spaces bucket host",
        { endpoint: "https://backups.nyc3.digitaloceanspaces.com", region: "nyc3", bucket: "backups", pathStyle: false },
      ],
      [
        "Spaces bucket host, path-style",
        { endpoint: "https://backups.nyc3.digitaloceanspaces.com", region: "nyc3", bucket: "backups", pathStyle: true },
      ],
      [
        "MinIO named like the bucket",
        { endpoint: "https://backups.example.com", region: "us-east-1", bucket: "backups", pathStyle: false },
      ],
    ];
    const seen = new Set<string>();
    for (const [name, destination] of https) {
      const config = { ...destination, pathPrefix: "", accessKeyId, secretAccessKey };
      const s3 = new Bun.S3Client(bunS3Options(config));
      for (const key of ["seylo/svc/pol/20260101T030000Z-run.sql.gz", "my backups/ünï code+plus=eq/20260101T030000Z-r.tar.gz"]) {
        for (const method of ["GET", "PUT", "DELETE"] as const) {
          const theirs = new URL(s3.presign(key, { method, expiresIn: 900 }));
          const target = storageTarget(config, key);
          expect(`${name}: ${theirs.origin}${theirs.pathname}`).toBe(`${name}: ${target.origin}${target.path}`);
          const date = theirs.searchParams.get("X-Amz-Date") ?? "";
          const now = new Date(
            `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
          );
          const ours = new URL(presign(config, { method, key, expiresIn: 900, now }));
          expect(`${name}: ${ours.searchParams.get("X-Amz-Signature")}`).toBe(`${name}: ${theirs.searchParams.get("X-Amz-Signature")}`);
        }
      }
      seen.add(storageTarget(config, "k").origin + storageTarget(config, "k").path);
    }
    // The cases above are not all the same address.
    expect(seen.has(`https://seylo-backups.${account}.r2.cloudflarestorage.com/k`)).toBe(true);
    expect(seen.has(`https://${account}.r2.cloudflarestorage.com/seylo-backups/k`)).toBe(true);
    expect(seen.has("https://seylo-backups.s3.dualstack.eu-central-1.amazonaws.com/k")).toBe(true);
    expect(seen.has("https://s3-fips.us-east-1.amazonaws.com/k")).toBe(false);
    expect(seen.has("https://seylo-backups.s3-fips.us-east-1.amazonaws.com/k")).toBe(true);
    expect(seen.has("https://backups.nyc3.digitaloceanspaces.com/k")).toBe(true);
    expect(seen.has("https://backups.nyc3.digitaloceanspaces.com/backups/k")).toBe(true);
    expect(seen.has("https://backups.example.com/backups/k")).toBe(true);
    expect(seen.has("http://127.0.0.1:9000/127/k")).toBe(true);
  });
});

describe("retention", () => {
  let panel: TestPanel;
  beforeEach(() => {
    panel = testPanel();
  });
  afterEach(() => panel.close());

  /** A policy keeping the newest 14 with 16 backups in its folder, and an object outside it. */
  function seedPolicy(c: Case) {
    const service = seedService(panel, { projectId: seedProject(panel).id, name: "files" });
    const destination = panel.deps.db
      .insert(backupDestinations)
      .values({
        name: c.name,
        provider: "other",
        ...c.config,
        accessKeyId,
        secretAccessKeySealed: panel.deps.secrets.seal(secretAccessKey, "backup.destination"),
      })
      .returning()
      .get();
    const policy = panel.deps.db
      .insert(backupPolicies)
      .values({ serviceId: service.id, destinationId: destination.id, target: "database", schedule: "0 3 * * *", keepLast: 14 })
      .returning()
      .get();
    const folder = `${folderOf(c)}${service.id}/${policy.id}/`;
    const objects = buckets.get(c.bucket) as Map<string, string>;
    const names = Array.from({ length: 16 }, (_, i) => `202601${String(i + 1).padStart(2, "0")}T030000Z-run${i}.dump`);
    for (const name of names) objects.set(`${folder}${name}`, "x");
    objects.set(`${folderOf(c)}other/${policy.id}/20250101T030000Z-x.dump`, "x");
    return { policy, folder, names, objects };
  }

  test.each(cases.map((c) => [c.name, c]))("keep newest 14: %s", async (_name, c) => {
    const { policy, folder, names, objects } = seedPolicy(c);
    const deleted = await viaProvider(() => pruneBackups(panel.deps, policy.id));
    expect(deleted).toEqual([`${folder}${names[0]}`, `${folder}${names[1]}`]);
    expect([...objects.keys()].filter((k) => k.startsWith(folder)).sort()).toEqual(names.slice(2).map((n) => `${folder}${n}`));
    expect(objects.size).toBe(15);
    expect(lines()).toEqual([
      `GET ${c.host}${c.base}?list-type=2&prefix=${encodeURIComponent(folder)}`,
      // A bucket host also lists where the objects from before 0.2.15 are.
      ...(c.legacy ? [`GET ${c.host}/?list-type=2&prefix=${encodeURIComponent(`${c.bucket}/${folder}`)}`] : []),
      `DELETE ${c.host}${c.base}${folder}${names[0]}`,
      `DELETE ${c.host}${c.base}${folder}${names[1]}`,
    ]);
  });

  test("a failed listing names the request and the provider's code, never the keys", async () => {
    const c = caseNamed("R2 with the path-style switch off");
    const { policy, folder } = seedPolicy(c);
    failNext = { status: 500, code: "InternalError", message: `We encountered an internal error for ${accessKeyId}.` };
    const error = await viaProvider(() => pruneBackups(panel.deps, policy.id)).catch((e: Error & { code?: string }) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`GET http://${c.host}${c.base}?list-type=2&prefix=${encodeURIComponent(folder)}`);
    expect(message).toContain('bucket "seylo-backups" in the path');
    expect(message).toContain("InternalError: We encountered an internal error for [key]");
    expect((error as { code?: string }).code).toBe("InternalError");
    expect(message).not.toContain(accessKeyId);
    expect(message).not.toContain(secretAccessKey);
  });
});

describe("the connection test's errors", () => {
  const r2 = withKeys(caseNamed("R2 with the path-style switch off"));

  test("an S3 error names the step, the request, how the bucket was addressed and the code, never the keys", async () => {
    failNext = {
      status: 400,
      code: "MalformedXML",
      message: `The XML you provided was not well formed or did not validate against our published schema (${accessKeyId}, ${secretAccessKey}).`,
    };
    const result = await viaProvider(() => testStorage(r2));
    expect(result).toMatchObject({ ok: false, failedStep: "write" });
    expect(result.message.replace(/\.seylo-test-[0-9a-f-]{36}/, ".seylo-test-ID")).toBe(
      `The write step failed: PUT http://${account}.r2.cloudflarestorage.com/seylo-backups/.seylo-test-ID (bucket "seylo-backups" in the path) failed with MalformedXML: The XML you provided was not well formed or did not validate against our published schema ([key], [key]). The bucket did not take it as a request on its objects: check the endpoint, the bucket name and the path-style switch.`,
    );
  });

  test("a virtual-hosted request says the bucket is in the host", async () => {
    failNext = { status: 400, code: "AuthorizationHeaderMalformed", message: "the region 'auto' is wrong; expecting 'eu-central-1'" };
    const virtual = caseNamed("AWS S3: virtual-hosted");
    const aws = withKeys({ ...virtual, config: { ...virtual.config, region: "auto" } });
    const result = await viaProvider(() => testStorage(aws));
    expect(result.failedStep).toBe("write");
    expect(result.message).toContain("PUT http://seylo-backups.s3.dualstack.us-east-1.amazonaws.com/seylo/.seylo-test-");
    expect(result.message).toContain("(bucket in the host) failed with AuthorizationHeaderMalformed");
    expect(result.message).toContain('the panel signed for "auto"');
  });

  test("refused keys, a missing bucket and an answer without an S3 code", async () => {
    failNext = {
      status: 403,
      code: "SignatureDoesNotMatch",
      message: "The request signature we calculated does not match the signature you provided.",
    };
    const auth = await viaProvider(() => testStorage(r2));
    expect(auth.failedStep).toBe("auth");
    expect(auth.message.replace(/\.seylo-test-[0-9a-f-]{36}/, ".seylo-test-ID")).toBe(
      `The bucket refused the keys: PUT http://${account}.r2.cloudflarestorage.com/seylo-backups/.seylo-test-ID (bucket "seylo-backups" in the path) failed with SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check the access key, secret and the key's permissions on this bucket.`,
    );

    const missing = await viaProvider(() => testStorage({ ...r2, bucket: "nope-bucket" }));
    expect(missing.failedStep).toBe("auth");
    expect(missing.message).toStartWith(`The bucket "nope-bucket" does not exist at http://${account}.r2.cloudflarestorage.com. PUT `);
    expect(missing.message).toContain("failed with NoSuchBucket: The specified bucket does not exist.");

    // The write is kept, the read answers 500 with no S3 body.
    requests.length = 0;
    const plain = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => (req.method === "GET" ? new Response("", { status: 500 }) : new Response("")),
    });
    try {
      const result = await testStorage({ ...r2, endpoint: `http://127.0.0.1:${plain.port}` });
      expect(result).toMatchObject({ ok: false, failedStep: "read" });
      expect(result.message).toMatch(
        new RegExp(
          `^The read step failed: GET http://127\\.0\\.0\\.1:${plain.port}/seylo-backups/\\.seylo-test-[0-9a-f-]{36} \\(bucket "seylo-backups" in the path\\) failed with no S3 error code\\.$`,
        ),
      );
    } finally {
      plain.stop(true);
    }

    const dead = await testStorage({ ...r2, endpoint: "http://127.0.0.1:1" });
    expect(dead).toMatchObject({ ok: false, failedStep: "connect" });
    expect(dead.message).toStartWith("Could not reach http://127.0.0.1:1 (");
  });
});

describe("which endpoints are a bucket's own host", () => {
  // [endpoint, bucket, path-style switch, where key "k" goes, where it was before 0.2.15 if elsewhere]
  const table: [string, string, boolean, string, string | null][] = [
    // Servers whose name starts with the bucket's: path-style, as the nodes' URLs always were.
    ["https://backups.example.com", "backups", false, "https://backups.example.com/backups/k", null],
    ["http://backups.internal:9000", "backups", false, "http://backups.internal:9000/backups/k", null],
    ["https://backups.storage.example.test", "backups", false, "https://backups.storage.example.test/backups/k", null],
    // A provider's endpoint whose first label happens to be the bucket's name is not a bucket host.
    ["https://nyc3.digitaloceanspaces.com", "nyc3", false, "https://nyc3.digitaloceanspaces.com/nyc3/k", null],
    ["https://fsn1.your-objectstorage.com", "fsn1", false, "https://fsn1.your-objectstorage.com/fsn1/k", null],
    [`https://${account}.eu.r2.cloudflarestorage.com`, account, false, `https://${account}.eu.r2.cloudflarestorage.com/${account}/k`, null],
    [
      "https://backups.nyc3.cdn.digitaloceanspaces.com",
      "backups",
      false,
      "https://backups.nyc3.cdn.digitaloceanspaces.com/backups/k",
      null,
    ],
    // Known providers' bucket hosts: used as they are.
    [
      `https://backups.${account}.r2.cloudflarestorage.com`,
      "backups",
      false,
      `https://backups.${account}.r2.cloudflarestorage.com/k`,
      "backups/k",
    ],
    [
      `https://backups.${account}.eu.r2.cloudflarestorage.com`,
      "backups",
      false,
      `https://backups.${account}.eu.r2.cloudflarestorage.com/k`,
      "backups/k",
    ],
    ["https://backups.nyc3.digitaloceanspaces.com", "backups", false, "https://backups.nyc3.digitaloceanspaces.com/k", "backups/k"],
    ["https://backups.storage.googleapis.com", "backups", false, "https://backups.storage.googleapis.com/k", "backups/k"],
    ["https://backups.s3.us-west-004.backblazeb2.com", "backups", false, "https://backups.s3.us-west-004.backblazeb2.com/k", "backups/k"],
    ["https://backups.s3.eu-central-1.wasabisys.com", "backups", false, "https://backups.s3.eu-central-1.wasabisys.com/k", "backups/k"],
    ["https://backups.us-east-1.linodeobjects.com", "backups", false, "https://backups.us-east-1.linodeobjects.com/k", "backups/k"],
    ["https://backups.s3.fr-par.scw.cloud", "backups", false, "https://backups.s3.fr-par.scw.cloud/k", "backups/k"],
    ["https://backups.fsn1.your-objectstorage.com", "backups", false, "https://backups.fsn1.your-objectstorage.com/k", "backups/k"],
    // Nodes put the bucket in front of these a second time before, so nothing was written there.
    ["https://backups.oss-cn-hangzhou.aliyuncs.com", "backups", false, "https://backups.oss-cn-hangzhou.aliyuncs.com/k", null],
    ["https://backups.s3-fips.us-east-1.amazonaws.com", "backups", false, "https://backups.s3-fips.us-east-1.amazonaws.com/k", null],
    // AWS bucket hosts go to the region's dual-stack host, as before.
    ["https://backups.s3.us-east-1.amazonaws.com", "backups", false, "https://backups.s3.dualstack.us-east-1.amazonaws.com/k", null],
    // The switch means what it says, on a bucket host too (the addressing from before 0.2.15).
    ["https://backups.nyc3.digitaloceanspaces.com", "backups", true, "https://backups.nyc3.digitaloceanspaces.com/backups/k", null],
    [
      `https://backups.${account}.r2.cloudflarestorage.com`,
      "backups",
      true,
      `https://backups.${account}.r2.cloudflarestorage.com/backups/k`,
      null,
    ],
  ];
  test.each(table)("%s, bucket %s, path-style %p", (endpoint, bucket, pathStyle, url, legacy) => {
    const config = { endpoint, region: "us-east-1", bucket, pathStyle };
    const target = storageTarget(config, "k");
    expect(`${target.origin}${target.path}`).toBe(url);
    expect(legacyKey(config, "k")).toBe(legacy);
  });
});

describe("backups from before 0.2.15 on a bucket host", () => {
  let panel: TestPanel;
  beforeEach(() => {
    panel = testPanel();
  });
  afterEach(() => panel.close());

  const spaces = caseNamed("a Spaces endpoint that is the bucket's own host");
  const r2 = caseNamed("R2 with the path-style switch off");

  /** A destination, a schedule and a way to add runs, for a service placed on a node. */
  function seed(c: Case) {
    const node = seedNode(panel);
    const service = seedService(panel, { projectId: seedProject(panel).id, name: "files", nodeIds: [node.id] });
    const destination = panel.deps.db
      .insert(backupDestinations)
      .values({
        name: c.name,
        provider: "other",
        ...c.config,
        accessKeyId,
        secretAccessKeySealed: panel.deps.secrets.seal(secretAccessKey, "backup.destination"),
      })
      .returning()
      .get();
    const policy = panel.deps.db
      .insert(backupPolicies)
      .values({ serviceId: service.id, destinationId: destination.id, target: "database", schedule: "0 3 * * *", keepLast: 14 })
      .returning()
      .get();
    const folder = `${folderOf(c)}${service.id}/${policy.id}/`;
    /** A succeeded backup whose object key the agent reported, or a run with the values given. */
    const run = (values: Partial<typeof backupRuns.$inferInsert> = {}) => {
      const row = panel.deps.db
        .insert(backupRuns)
        .values({
          kind: "backup",
          target: "database",
          serviceId: service.id,
          destinationId: destination.id,
          policyId: policy.id,
          nodeId: node.id,
          status: "succeeded",
          startedAt: new Date(),
          ...values,
        })
        .returning()
        .get();
      if (row.kind !== "backup") return { ...row, key: "" };
      const key = `${folder}20260101T030000Z-${row.id}.dump`;
      panel.deps.db.update(backupRuns).set({ objectKey: key }).where(eq(backupRuns.id, row.id)).run();
      return { ...row, key };
    };
    return { node, service, policy, run, folder, objects: buckets.get(c.bucket) as Map<string, string> };
  }

  test("retention counts them towards keep newest 14 and deletes the oldest where they are", async () => {
    const { policy, folder, objects } = seed(spaces);
    const names = Array.from({ length: 16 }, (_, i) => `202601${String(i + 1).padStart(2, "0")}T030000Z-run${i}.dump`);
    // Ten from before 0.2.15 under "backups/", six since.
    for (const name of names.slice(0, 10)) objects.set(`backups/${folder}${name}`, "x");
    for (const name of names.slice(10)) objects.set(`${folder}${name}`, "x");
    const deleted = await viaProvider(() => pruneBackups(panel.deps, policy.id));
    expect(deleted).toEqual([`backups/${folder}${names[0]}`, `backups/${folder}${names[1]}`]);
    expect([...objects.keys()].sort()).toEqual(
      [...names.slice(2, 10).map((n) => `backups/${folder}${n}`), ...names.slice(10).map((n) => `${folder}${n}`)].sort(),
    );
    expect(lines()).toEqual([
      `GET ${spaces.host}/?list-type=2&prefix=${encodeURIComponent(folder)}`,
      `GET ${spaces.host}/?list-type=2&prefix=${encodeURIComponent(`backups/${folder}`)}`,
      `DELETE ${spaces.host}/backups/${folder}${names[0]}`,
      `DELETE ${spaces.host}/backups/${folder}${names[1]}`,
    ]);
  });

  test("deleting a run deletes its object where it is; other destinations get one delete", async () => {
    const { cookie } = await createUser(panel, "owner");
    for (const c of [spaces, r2]) {
      const { service, run, objects } = seed(c);
      const old = run();
      objects.set(c.legacy ? `${c.bucket}/${old.key}` : old.key, "x");
      requests.length = 0;
      const response = await viaProvider(() => callOp(panel, backupOps.deleteRun, { serviceId: service.id, runId: old.id }, { cookie }));
      expect(response.status).toBe(200);
      expect(objects.size).toBe(0);
      expect(lines()).toEqual(
        c.legacy ? [`DELETE ${c.host}/${old.key}`, `DELETE ${c.host}/${c.bucket}/${old.key}`] : [`DELETE ${c.host}${c.base}${old.key}`],
      );
    }
  });

  test("a restore downloads it from where it is", async () => {
    /** The URL the restore of a backup gets, its object put where `where` says (or nowhere). */
    async function restoreUrl(c: Case, where: "now" | "before" | "nowhere") {
      const { node, run, objects } = seed(c);
      const source = run();
      if (where === "now") objects.set(source.key, "the archive");
      if (where === "before") objects.set(`${c.bucket}/${source.key}`, "the old archive");
      const restore = run({ kind: "restore", sourceRunId: source.id, status: "running" });
      requests.length = 0;
      const [signed] = await viaProvider(() =>
        signBackupRequests(panel.deps, node.id, {
          signingId: restore.id,
          requests: [create(BackupStorageRequestSchema, { op: BackupStorageOp.GET, key: source.key })],
        }),
      );
      const url = new URL(signed?.url ?? "");
      return { key: source.key, at: `${url.host}${url.pathname}`, url, checked: lines() };
    }

    const now = await restoreUrl(spaces, "now");
    expect(now.at).toBe(`${spaces.host}/${now.key}`);
    expect(now.checked).toEqual([`HEAD ${spaces.host}/${now.key}`]);

    const before = await restoreUrl(spaces, "before");
    expect(before.at).toBe(`${spaces.host}/backups/${before.key}`);
    expect(before.checked).toEqual([`HEAD ${spaces.host}/${before.key}`, `HEAD ${spaces.host}/backups/${before.key}`]);
    expect(await viaProvider(async () => (await fetch(before.url)).text())).toBe("the old archive");

    // In neither place: the key as reported, so the node's download fails with the bucket's own NoSuchKey.
    const nowhere = await restoreUrl(spaces, "nowhere");
    expect(nowhere.at).toBe(`${spaces.host}/${nowhere.key}`);

    // Destinations whose addressing did not change: no lookup.
    const other = await restoreUrl(r2, "now");
    expect(other.at).toBe(`${r2.host}${r2.base}${other.key}`);
    expect(other.checked).toEqual([]);
  });

  test("a bucket that does not answer the lookup leaves the key as reported", async () => {
    // Takes the connection and never answers.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const saved = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${silent.port}`;
    try {
      const key = "files/pol/20260101T030000Z-r.dump";
      expect(await storedKey(withKeys(spaces), key, 300)).toBe(key);
    } finally {
      if (saved === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = saved;
      silent.stop(true);
    }
  });
});
