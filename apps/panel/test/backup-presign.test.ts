import { describe, expect, test } from "bun:test";
import { presign, presignRaw, type SignedMethod, signedRequest } from "../src/modules/backups/presign";
import vectorFile from "./fixtures/s3-presign-vectors.json";

interface Vector {
  destination: { endpoint: string; region: string; bucket: string; pathStyle: boolean };
  method: string;
  key: string;
  query: Record<string, string>;
  expiresIn: number;
  url: string;
}
interface HeaderVector {
  destination: Vector["destination"];
  method: string;
  key: string;
  query: Record<string, string>;
  body: string;
  url: string;
  date: string;
  authorization: string;
}
const vectors = vectorFile.presigned as unknown as Vector[];
const headerVectors = vectorFile.headerSigned as unknown as HeaderVector[];

const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** 20261108T043805Z -> Date */
const parseAmzDate = (raw: string) =>
  new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`);

function dateOf(url: string): Date {
  return parseAmzDate(new URL(url).searchParams.get("X-Amz-Date") ?? "");
}

describe("SigV4 presigned URLs", () => {
  test("the example from the AWS documentation (GET test.txt, 24 hours)", () => {
    const url = presignRaw({
      method: "GET",
      origin: "https://examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      query: {},
      region: "us-east-1",
      accessKeyId,
      secretAccessKey,
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  // minio-go's signer, the client the agent used with the keys (go/internal/backup/presign_vectors_test.go).
  test.each(vectors.map((v) => [`${v.destination.endpoint} ${v.method} ${v.key || "(bucket)"} ${Object.keys(v.query).join(",")}`, v]))(
    "same URL as minio-go: %s",
    (_name, v) => {
      const url = presign(
        { ...v.destination, pathPrefix: "", accessKeyId, secretAccessKey },
        { method: v.method as SignedMethod, key: v.key || null, query: v.query, expiresIn: v.expiresIn, now: dateOf(v.url) },
      );
      expect(url).toBe(v.url);
    },
  );

  // The multipart steps the panel makes itself, against minio-go's header signer.
  test.each(headerVectors.map((v) => [`${v.destination.endpoint} ${v.method} ${Object.keys(v.query).join(",")}`, v]))(
    "same Authorization as minio-go: %s",
    (_name, v) => {
      const signed = signedRequest(
        { ...v.destination, pathPrefix: "", accessKeyId, secretAccessKey },
        { method: v.method as SignedMethod, key: v.key, query: v.query, body: v.body, now: parseAmzDate(v.date) },
      );
      expect(signed.url).toBe(v.url);
      expect(signed.headers.authorization).toBe(v.authorization);
      expect(signed.headers["x-amz-date"]).toBe(v.date);
    },
  );

  test("Bun's own S3 presigner agrees for plain object requests", () => {
    const config = {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "backups",
      pathPrefix: "",
      pathStyle: true,
      accessKeyId,
      secretAccessKey,
    };
    const s3 = new Bun.S3Client({ ...config, virtualHostedStyle: false });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const theirs = s3.presign("seylo/svc/pol/20260101T030000Z-run.tar.gz", { method, expiresIn: 900 });
      const ours = presign(config, { method, key: "seylo/svc/pol/20260101T030000Z-run.tar.gz", expiresIn: 900, now: dateOf(theirs) });
      expect(new URL(ours).searchParams.get("X-Amz-Signature")).toBe(new URL(theirs).searchParams.get("X-Amz-Signature"));
    }
  });

  test("an expiry outside 1 second to 7 days is refused", () => {
    const config = { endpoint: "http://h", region: "auto", bucket: "b", pathPrefix: "", pathStyle: true, accessKeyId, secretAccessKey };
    expect(() => presign(config, { method: "GET", key: "k", expiresIn: 0 })).toThrow();
    expect(() => presign(config, { method: "GET", key: "k", expiresIn: 604801 })).toThrow();
  });
});
