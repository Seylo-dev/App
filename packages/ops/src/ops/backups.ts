// Database and volume backups to S3-compatible storage (AWS S3, Cloudflare
// R2, MinIO). Destinations are panel-wide; schedules (policies) belong to a
// service. Nodes upload straight to the bucket; the panel keeps the runs.

import { type TOptional, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const DestinationProvider = Type.Union([Type.Literal("s3"), Type.Literal("r2"), Type.Literal("minio"), Type.Literal("other")]);

/** Every field optional, for update ops where a missing field keeps its value. */
function optionalFields<T extends TProperties>(fields: T): { [K in keyof T]: TOptional<T[K]> } {
  return Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, Type.Optional(schema as TSchema)])) as {
    [K in keyof T]: TOptional<T[K]>;
  };
}

const DestinationFields = {
  name: Type.String({ minLength: 1, maxLength: 60 }),
  provider: DestinationProvider,
  /** https://<account>.r2.cloudflarestorage.com, https://s3.eu-central-1.amazonaws.com, ... */
  endpoint: Type.String({ minLength: 8, maxLength: 500, pattern: "^https?://" }),
  region: Type.String({ minLength: 1, maxLength: 60, default: "auto" }),
  bucket: Type.String({ minLength: 3, maxLength: 63, pattern: "^[a-z0-9][a-z0-9.-]*[a-z0-9]$" }),
  /** Folder inside the bucket, without a leading slash. */
  pathPrefix: Type.String({ maxLength: 200, pattern: "^([^/][^\\\\]*)?$", default: "" }),
  /** MinIO and some others need path-style URLs. */
  pathStyle: Type.Boolean({ default: false }),
  accessKeyId: Type.String({ minLength: 1, maxLength: 200 }),
};

export const Destination = Type.Object({
  id: Id,
  ...DestinationFields,
  /** Policies that write here; a destination in use cannot be deleted. */
  policyCount: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** What members see when picking a destination for a schedule. */
export const DestinationChoice = Type.Object({ id: Id, name: Type.String(), provider: DestinationProvider, bucket: Type.String() });

export const BackupTarget = Type.Union([Type.Literal("database"), Type.Literal("volume")]);

/** Five-field cron expression in UTC, for example "0 3 * * *". */
export const CronSchedule = Type.String({ minLength: 9, maxLength: 100, pattern: "^\\S+( \\S+){4}$" });

export const Policy = Type.Object({
  id: Id,
  serviceId: Id,
  destinationId: Id,
  destinationName: Type.String(),
  target: BackupTarget,
  /** Set for volume backups. */
  volumeId: Type.Union([Id, Type.Null()]),
  volumeName: Type.Union([Type.String(), Type.Null()]),
  schedule: CronSchedule,
  /** Newest N successful backups kept in the bucket; older ones are deleted. */
  keepLast: Type.Integer({ minimum: 1, maximum: 1000 }),
  /** Volume backups only: stop the service while copying. */
  stopService: Type.Boolean(),
  enabled: Type.Boolean(),
  nextRunAt: Type.Union([Timestamp, Type.Null()]),
  lastRun: Type.Union([Type.Object({ id: Id, status: Type.String(), finishedAt: Type.Union([Timestamp, Type.Null()]) }), Type.Null()]),
  createdAt: Timestamp,
});

export const RunStatus = Type.Union([Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed")]);

export const Run = Type.Object({
  id: Id,
  kind: Type.Union([Type.Literal("backup"), Type.Literal("restore")]),
  serviceId: Id,
  /** Null for manual runs. */
  policyId: Type.Union([Id, Type.Null()]),
  /** Null once the destination was deleted: the backup can then no longer be restored or deleted from the bucket. */
  destinationId: Type.Union([Id, Type.Null()]),
  target: BackupTarget,
  volumeId: Type.Union([Id, Type.Null()]),
  /** Volume runs: the volume's name; null for database runs and once the volume was deleted. */
  volumeName: Type.Union([Type.String(), Type.Null()]),
  /** Restores: the backup run they restored. */
  sourceRunId: Type.Union([Id, Type.Null()]),
  /** Restores: when the backup they restored was started. */
  sourceStartedAt: Type.Union([Timestamp, Type.Null()]),
  status: RunStatus,
  objectKey: Type.Union([Type.String(), Type.Null()]),
  sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  /** Set once the object was removed by retention or by hand; it can no longer be restored. */
  deletedAt: Type.Union([Timestamp, Type.Null()]),
  startedAt: Timestamp,
  finishedAt: Type.Union([Timestamp, Type.Null()]),
});

const serviceScope = (action: `${string}.${string}`) => permission.service(action, (input: { serviceId: string }) => input.serviceId);

export const listDestinations = defineOp({
  id: "backups.listDestinations",
  kind: "query",
  summary: "List backup destinations",
  description:
    "Lists the panel's S3/R2 backup destinations. Owners and admins get every field; other signed-in people with a grant (services.view or backups.edit somewhere) get only id, name, provider and bucket in the choices list, for picking one in a schedule; an account with no grant gets empty lists.",
  input: Type.Object({}),
  output: Type.Object({
    /** Empty for callers without backups.destinations. */
    destinations: Type.Array(Destination),
    choices: Type.Array(DestinationChoice),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const createDestination = defineOp({
  id: "backups.createDestination",
  kind: "mutation",
  summary: "Add a backup destination",
  description:
    "Adds an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) for backups. Run backups.testDestination first to check the keys.",
  input: Type.Object({ ...DestinationFields, secretAccessKey: Type.String({ minLength: 1, maxLength: 500 }) }),
  output: Destination,
  sensitive: { input: ["secretAccessKey"] },
  permission: permission.global("backups.destinations"),
  mcp: false,
  audit: true,
});

export const updateDestination = defineOp({
  id: "backups.updateDestination",
  kind: "mutation",
  summary: "Change a backup destination",
  description:
    "Changes a destination. Fields left out keep their value, including the secret key. Existing backups stay where they were written.",
  input: Type.Object({
    destinationId: Id,
    ...optionalFields(DestinationFields),
    secretAccessKey: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  }),
  output: Destination,
  sensitive: { input: ["secretAccessKey"] },
  permission: permission.global("backups.destinations"),
  mcp: false,
  audit: true,
});

export const deleteDestination = defineOp({
  id: "backups.deleteDestination",
  kind: "destructive",
  summary: "Delete a backup destination",
  description:
    "Removes a destination from the panel. Fails while a schedule still writes to it. Objects already in the bucket are not deleted, but the panel can no longer restore them.",
  input: Type.Object({ destinationId: Id }),
  output: Empty,
  permission: permission.global("backups.destinations"),
  mcp: false,
  audit: true,
});

export const testDestination = defineOp({
  id: "backups.testDestination",
  kind: "mutation",
  summary: "Test a backup destination",
  description:
    "Writes, reads and deletes a small test object to check the endpoint, bucket and keys. Test a saved destination by id, or unsaved settings with draft (a draft without secretAccessKey reuses the saved key of destinationId).",
  input: Type.Object({
    destinationId: Type.Optional(Id),
    draft: Type.Optional(
      Type.Object({
        ...DestinationFields,
        secretAccessKey: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      }),
    ),
  }),
  output: Type.Object({
    ok: Type.Boolean(),
    /** Which step failed: connect, auth, write, read or delete. Null when ok. */
    failedStep: Type.Union([Type.String(), Type.Null()]),
    message: Type.String(),
    latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
  sensitive: { input: ["draft.secretAccessKey"] },
  permission: permission.global("backups.destinations"),
  mcp: false,
  audit: true,
});

export const listPolicies = defineOp({
  id: "backups.listPolicies",
  kind: "query",
  summary: "List a service's backup schedules",
  description: "Lists the backup schedules of a service (its database, or each volume) with the next run time and the last result.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ policies: Type.Array(Policy) }),
  permission: serviceScope("backups.view"),
  mcp: true,
  audit: false,
});

const PolicyFields = {
  destinationId: Id,
  schedule: CronSchedule,
  keepLast: Type.Integer({ minimum: 1, maximum: 1000 }),
  stopService: Type.Boolean(),
  enabled: Type.Boolean(),
};

export const createPolicy = defineOp({
  id: "backups.createPolicy",
  kind: "mutation",
  summary: "Add a backup schedule",
  description:
    "Schedules backups of a service's database or one of its volumes to a destination, keeping the newest keepLast. Database services back up with the engine's dump tool; volumes as a tar.zst archive.",
  input: Type.Object({
    serviceId: Id,
    target: BackupTarget,
    /** Required for volume backups. */
    volumeId: Type.Optional(Id),
    destinationId: Id,
    schedule: CronSchedule,
    keepLast: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    stopService: Type.Optional(Type.Boolean()),
    enabled: Type.Optional(Type.Boolean()),
  }),
  output: Policy,
  permission: serviceScope("backups.edit"),
  mcp: true,
  audit: true,
});

export const updatePolicy = defineOp({
  id: "backups.updatePolicy",
  kind: "mutation",
  summary: "Change a backup schedule",
  description: "Changes a schedule's destination, timing, retention or on/off state. Fields left out keep their value.",
  input: Type.Object({
    serviceId: Id,
    policyId: Id,
    ...optionalFields(PolicyFields),
  }),
  output: Policy,
  permission: serviceScope("backups.edit"),
  mcp: true,
  audit: true,
});

export const deletePolicy = defineOp({
  id: "backups.deletePolicy",
  kind: "destructive",
  summary: "Delete a backup schedule",
  description: "Stops a schedule. Backups it already made stay in the bucket and in the run list until deleted.",
  input: Type.Object({ serviceId: Id, policyId: Id }),
  output: Empty,
  permission: serviceScope("backups.edit"),
  mcp: true,
  audit: true,
});

export const runNow = defineOp({
  id: "backups.runNow",
  kind: "mutation",
  summary: "Back up now",
  description:
    "Starts one backup right away: of one schedule (policyId; also a disabled one, counted toward its keepLast), or a one-off of the database or a volume to a destination (kept until deleted). Returns the run; follow it with backups.listRuns or the live service topic. To back up every enabled schedule of a service at once, use backups.runAll.",
  input: Type.Object({
    serviceId: Id,
    policyId: Type.Optional(Id),
    target: Type.Optional(BackupTarget),
    volumeId: Type.Optional(Id),
    destinationId: Type.Optional(Id),
  }),
  output: Run,
  permission: serviceScope("backups.run"),
  mcp: true,
  audit: true,
});

/** Why backups.runAll left a schedule out. */
export const RunAllSkip = Type.Union([Type.Literal("disabled"), Type.Literal("running")]);

export const runAll = defineOp({
  id: "backups.runAll",
  kind: "mutation",
  summary: "Back up every schedule now",
  description:
    "Starts a backup of every enabled schedule of a service at once (its database and each scheduled volume), each to its own destination and counted toward its own keepLast, as when it runs on time. Disabled schedules are skipped, and so is a schedule with a backup still running (never started twice); skipped says which and why, and runs is empty when every schedule was skipped. A service with no schedule is refused (BAD_REQUEST, reason noSchedules): start a one-off with backups.runNow. When no backup could start (the node offline, an agent too old) it fails as backups.runNow does; when only some could, runs also lists those that failed to start, with their error. backups.runNow with a policyId starts a single schedule.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    /** The runs it started, in the schedules' order: running, or failed when the node could not start one. */
    runs: Type.Array(Run),
    skipped: Type.Array(Type.Object({ policyId: Id, reason: RunAllSkip })),
  }),
  permission: serviceScope("backups.run"),
  mcp: true,
  audit: true,
});

export const listRuns = defineOp({
  id: "backups.listRuns",
  kind: "query",
  summary: "List backup runs",
  description:
    "Lists a service's backup and restore runs, newest first, 50 per page. Pass the last run's startedAt as before for the next page.",
  input: Type.Object({
    serviceId: Id,
    policyId: Type.Optional(Id),
    before: Type.Optional(Timestamp),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  }),
  output: Type.Object({ runs: Type.Array(Run), hasMore: Type.Boolean() }),
  permission: serviceScope("backups.view"),
  mcp: true,
  audit: false,
});

export const restore = defineOp({
  id: "backups.restore",
  kind: "destructive",
  summary: "Restore a backup",
  description:
    "Restores a successful backup over the service's current data (database or volume). Current data is replaced and cannot be recovered unless backed up first. The service name must be repeated to confirm. A backup whose destination was deleted (destinationId null) cannot be restored (CONFLICT, reason noDestination).",
  input: Type.Object({
    serviceId: Id,
    runId: Id,
    confirmName: Type.String({ description: "Must equal the service's name." }),
    /** Take a fresh backup to the same destination before restoring. */
    backupFirst: Type.Optional(Type.Boolean()),
  }),
  output: Run,
  permission: serviceScope("backups.restore"),
  mcp: true,
  audit: true,
});

export const deleteRun = defineOp({
  id: "backups.deleteRun",
  kind: "destructive",
  summary: "Delete a backup",
  description:
    "Deletes a backup's object from the bucket and marks the run deleted. It can no longer be restored. When the backup's destination was deleted (destinationId null), the panel has no keys for that bucket: the run is only marked deleted, and its object stays in the bucket, to delete there by hand.",
  input: Type.Object({ serviceId: Id, runId: Id }),
  output: Run,
  permission: serviceScope("backups.edit"),
  mcp: true,
  audit: true,
});

/** How long a backups.downloadUrl link works. */
export const downloadUrlSeconds = 300;

export const downloadUrl = defineOp({
  id: "backups.downloadUrl",
  kind: "mutation",
  summary: "Get a backup's download link",
  description:
    "Returns a link that downloads one successful backup's file straight from its bucket for 5 minutes: a GET presigned with the destination's keys for that backup's own object only, saved as fileName (<service>-<volume name or database>-<UTC start, YYYY-MM-DD_HHmm>.<the file's extension>). The browser or tool that opens it reaches the bucket itself, so the bucket must be reachable from there; the link carries no key, only its signature. Needs backups.restore, and on a database service databases.credentials too (a dump holds the database's logins). Refused for a run that is not a successful backup or was deleted (BAD_REQUEST) and for a backup whose destination was deleted (CONFLICT, reason noDestination). Model callers (MCP, AI) need a person's approval first, as the file leaves the panel.",
  input: Type.Object({ serviceId: Id, runId: Id }),
  output: Type.Object({
    url: Type.String(),
    fileName: Type.String(),
    expiresAt: Timestamp,
  }),
  permission: serviceScope("backups.restore"),
  modelApproval: true,
  mcp: true,
  audit: true,
});
