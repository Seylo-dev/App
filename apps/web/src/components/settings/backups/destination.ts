// The backup destination form: validation that mirrors the contract's
// patterns, so mistakes show next to the field instead of as a 400 after
// Save. The secret key is required on create and optional when editing
// (left out = keep the stored one).

import type { backups, OpInput } from "@seylo/ops";

type Fields = Omit<OpInput<typeof backups.createDestination>, "secretAccessKey">;
export type Provider = Fields["provider"];

export interface DestinationDraft extends Fields {
  secretAccessKey: string;
}

export const providers: readonly Provider[] = ["s3", "r2", "minio", "other"];

export const emptyDestination: DestinationDraft = {
  name: "",
  provider: "r2",
  endpoint: "",
  region: "auto",
  bucket: "",
  pathPrefix: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

/** Example endpoint per provider, shown under the field. */
export function endpointHint(provider: Provider): string {
  switch (provider) {
    case "r2":
      return "https://<account-id>.r2.cloudflarestorage.com";
    case "s3":
      return "https://s3.eu-central-1.amazonaws.com";
    case "minio":
      return "https://minio.example.com:9000";
    default:
      return "https://storage.example.com";
  }
}

const bucketPattern = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

export type DestinationResult =
  | { ok: true; value: Fields & { secretAccessKey: string | undefined } }
  | { ok: false; errors: (keyof DestinationDraft)[] };

export function destinationInput(draft: DestinationDraft, editing: boolean): DestinationResult {
  const errors: (keyof DestinationDraft)[] = [];
  const name = draft.name.trim();
  const endpoint = draft.endpoint.trim().replace(/\/+$/, "");
  const bucket = draft.bucket.trim();
  const region = draft.region.trim() || "auto";
  const pathPrefix = draft.pathPrefix.trim().replace(/^\/+/, "");
  const accessKeyId = draft.accessKeyId.trim();
  const secret = draft.secretAccessKey.trim();
  if (!name || name.length > 60) errors.push("name");
  if (!/^https?:\/\/\S+$/.test(endpoint) || endpoint.length < 8 || endpoint.length > 500) errors.push("endpoint");
  if (bucket.length < 3 || bucket.length > 63 || !bucketPattern.test(bucket)) errors.push("bucket");
  if (region.length > 60) errors.push("region");
  if (pathPrefix.length > 200 || pathPrefix.includes("\\")) errors.push("pathPrefix");
  if (!accessKeyId || accessKeyId.length > 200) errors.push("accessKeyId");
  if ((!editing && !secret) || secret.length > 500) errors.push("secretAccessKey");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      provider: draft.provider,
      endpoint,
      region,
      bucket,
      pathPrefix,
      pathStyle: draft.pathStyle,
      accessKeyId,
      secretAccessKey: secret || undefined,
    },
  };
}
