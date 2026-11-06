import { expect, test } from "bun:test";
import { destinationInput, emptyDestination } from "./destination";

const r2 = {
  ...emptyDestination,
  name: "R2 backups",
  endpoint: "https://abc.r2.cloudflarestorage.com/",
  bucket: "seylo-backups",
  pathPrefix: "/prod",
  accessKeyId: "AKIA",
  secretAccessKey: "s3cr3t",
};

test("a valid destination is trimmed and normalised", () => {
  const result = destinationInput(r2, false);
  expect(result).toEqual({
    ok: true,
    value: {
      name: "R2 backups",
      provider: "r2",
      endpoint: "https://abc.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "seylo-backups",
      pathPrefix: "prod",
      pathStyle: false,
      accessKeyId: "AKIA",
      secretAccessKey: "s3cr3t",
    },
  });
});

test("the secret is required on create and may stay empty when editing", () => {
  expect(destinationInput({ ...r2, secretAccessKey: "" }, false)).toEqual({ ok: false, errors: ["secretAccessKey"] });
  const edit = destinationInput({ ...r2, secretAccessKey: "" }, true);
  expect(edit.ok && edit.value.secretAccessKey).toBeUndefined();
});

test("bucket names and endpoints follow S3 rules", () => {
  const bad = destinationInput({ ...r2, bucket: "Bad_Bucket", endpoint: "s3.amazonaws.com" }, false);
  expect(bad).toEqual({ ok: false, errors: ["endpoint", "bucket"] });
});
