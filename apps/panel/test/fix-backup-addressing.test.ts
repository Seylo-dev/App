// The panel's own S3 requests (the connection test, retention's list and
// delete, deleting a run's object) address the bucket exactly as the URLs
// nodes get (presign.ts storageTarget): path-style unless the endpoint is a
// virtual-host one. Before, Bun's client got virtualHostedStyle whenever
// the path-style switch was off and then sent no bucket at all: R2 read the
// test write PUT /.seylo-test-... as CreateBucket (MalformedXML), deletes
// went to a bucket named after the key's first folder, the listing became
// ListBuckets.
//
// The fake provider is an HTTP proxy (HTTP_PROXY, http:// endpoints), so it
// sees the host each request was for: AWS and R2 host names included.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { backupDestinations, backupPolicies } from "../src/db/schema";
import { bunS3Options } from "../src/modules/backups/address";
import { presign, storageTarget } from "../src/modules/backups/presign";
import { pruneBackups } from "../src/modules/backups/runs";
import { deleteObject, listObjects, type StorageConfig, testStorage } from "../src/modules/backups/storage";
import { type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./seed-helpers";

const accessKeyId = "AKIDEXAMPLE";
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

// An S3 provider: a request is virtual-hosted when its host starts with a
// bucket's name, else path-style; a path with no bucket in it is a request
// on the service (PUT = CreateBucket, whose body must be XML; GET / =
// ListBuckets), as R2 and AWS read them.
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
  const label = host.split(".")[0] ?? "";
  if (host.includes(".") && buckets.has(label)) {
    bucket = label;
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
  if (req.method === "GET") {
    const body = objects.get(key);
    return body === undefined ? xmlError(404, "NoSuchKey", "The specified key does not exist.") : new Response(body);
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
}

const cases: Case[] = [
  {
    // The owner's destination: R2, "Use path-style URLs" off, no folder.
    name: "R2 with the path-style switch off",
    config: {
      endpoint: "http://0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "seylo-backups",
      pathPrefix: "",
      pathStyle: false,
    },
    host: "0123456789abcdef.r2.cloudflarestorage.com",
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
    name: "an endpoint whose host already starts with the bucket",
    config: { endpoint: "http://backups.storage.example.test", region: "auto", bucket: "backups", pathPrefix: "seylo", pathStyle: false },
    host: "backups.storage.example.test",
    base: "/",
    bucket: "backups",
    region: "auto",
  },
];

const withKeys = (c: Case): StorageConfig => ({ ...c.config, accessKeyId, secretAccessKey });
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
      ["R2", { endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com", region: "auto", bucket: "seylo-backups", pathStyle: false }],
      [
        "R2 path-style",
        { endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com", region: "auto", bucket: "seylo-backups", pathStyle: true },
      ],
      [
        "R2 bucket host",
        {
          endpoint: "https://seylo-backups.0123456789abcdef.r2.cloudflarestorage.com",
          region: "auto",
          bucket: "seylo-backups",
          pathStyle: false,
        },
      ],
      [
        "R2 bucket in the endpoint path",
        {
          endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com/seylo-backups",
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
    expect(seen.has("https://seylo-backups.0123456789abcdef.r2.cloudflarestorage.com/k")).toBe(true);
    expect(seen.has("https://0123456789abcdef.r2.cloudflarestorage.com/seylo-backups/k")).toBe(true);
    expect(seen.has("https://seylo-backups.s3.dualstack.eu-central-1.amazonaws.com/k")).toBe(true);
    expect(seen.has("https://s3-fips.us-east-1.amazonaws.com/k")).toBe(false);
    expect(seen.has("https://seylo-backups.s3-fips.us-east-1.amazonaws.com/k")).toBe(true);
    expect(seen.has("https://backups.nyc3.digitaloceanspaces.com/k")).toBe(true);
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
      `DELETE ${c.host}${c.base}${folder}${names[0]}`,
      `DELETE ${c.host}${c.base}${folder}${names[1]}`,
    ]);
  });

  test("a failed listing names the request and the provider's code, never the keys", async () => {
    const c = cases[0] as Case;
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
  const r2 = withKeys(cases[0] as Case);

  test("an S3 error names the step, the request, how the bucket was addressed and the code, never the keys", async () => {
    failNext = {
      status: 400,
      code: "MalformedXML",
      message: `The XML you provided was not well formed or did not validate against our published schema (${accessKeyId}, ${secretAccessKey}).`,
    };
    const result = await viaProvider(() => testStorage(r2));
    expect(result).toMatchObject({ ok: false, failedStep: "write" });
    expect(result.message.replace(/\.seylo-test-[0-9a-f-]{36}/, ".seylo-test-ID")).toBe(
      'The write step failed: PUT http://0123456789abcdef.r2.cloudflarestorage.com/seylo-backups/.seylo-test-ID (bucket "seylo-backups" in the path) failed with MalformedXML: The XML you provided was not well formed or did not validate against our published schema ([key], [key]). The bucket did not take it as a request on its objects: check the endpoint, the bucket name and the path-style switch.',
    );
  });

  test("a virtual-hosted request says the bucket is in the host", async () => {
    failNext = { status: 400, code: "AuthorizationHeaderMalformed", message: "the region 'auto' is wrong; expecting 'eu-central-1'" };
    const aws = withKeys({ ...(cases[2] as Case), config: { ...(cases[2] as Case).config, region: "auto" } });
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
      'The bucket refused the keys: PUT http://0123456789abcdef.r2.cloudflarestorage.com/seylo-backups/.seylo-test-ID (bucket "seylo-backups" in the path) failed with SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check the access key, secret and the key\'s permissions on this bucket.',
    );

    const missing = await viaProvider(() => testStorage({ ...r2, bucket: "nope-bucket" }));
    expect(missing.failedStep).toBe("auth");
    expect(missing.message).toStartWith(
      'The bucket "nope-bucket" does not exist at http://0123456789abcdef.r2.cloudflarestorage.com. PUT ',
    );
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
