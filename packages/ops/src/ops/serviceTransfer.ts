// Export a service to a .zip file and import such a file into a project on
// this panel or another one. The file format (format version 1) is defined
// here too, so the panel, the web app and later the CLI check it with the
// same schemas:
//
//   README.txt                           how to read and import the file
//   secrets.enc                          encrypted (passphrase): every setting and secret value
//   services/<name>/service.json         settings in clear, only when secret values were left out
//   services/<name>/source/upload.tar.gz the newest uploaded archive of an upload app
//   services/<name>/volumes/<vol>.tar.gz a volume's data, ExportVolume's stream as it is
//   manifest.json                        format, versions, every entry's size and sha256
//   manifest.sig                         HMAC of manifest.json, only when encrypted
//
// The zip itself never goes through an op (they are JSON only): exports
// download from a one-minute link, the browser reads an import's small
// entries and sends them to importBegin, and the uploaded archive and
// volume data go up in parts to one-minute upload links. Both ops areas
// are for owners and admins only.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { GitUrl, Id, Timestamp } from "../schemas";
import { AlertRuleEvent } from "./alerts";
import { BackupSelection, DestinationProvider } from "./backups";
import { BuildSettings } from "./builds";
import { Command, CronConcurrency, CronSchedule, JobName, TimeZone } from "./cron";
import { Cidr, ContainerPort, DomainForward, DomainRateLimit, DomainRedirect, Hostname, HttpsMode, PathPrefix } from "./domains";
import { StreamTicket } from "./logs";
import { Message, PageHtml } from "./maintenance";
import { ChannelKind } from "./notifications";
import {
  ContainerSettings,
  CrashPolicy,
  CronSettings,
  DeployStrategy,
  GitBranch,
  GitProviderKind,
  HealthCheck,
  Port,
  ReferenceEffect,
  RepoFullPath,
  Resources,
  ServiceDetail,
  ServiceKind,
  ServiceName,
  SourceSummary,
  VolumeName,
  WatchPaths,
} from "./services";
import { TunnelMode } from "./tunnels";
import { CheckSettings } from "./uptime";

/** manifest.json's `format`. Fixed, not the brand: a rename must not make old files unreadable. */
export const exportFormat = "service-export";
/** The newest format this panel writes and reads. */
export const exportFormatVersion = 1;
/** Features a file may say it needs (manifest.requires). An importer refuses names it does not know. */
export const knownFeatures: readonly string[] = [];

/** Limits of the format (CONTRACTS.md "Service export and import"). */
export const transferLimits = {
  entries: 200,
  volumesPerService: 20,
  manifestBytes: 256 * 1024,
  /** service.json and secrets.enc each. */
  documentBytes: 2 * 1024 * 1024,
  /** service.json and secrets.enc together: they go through one op of at most 4 MiB. */
  documentsBytes: 3.5 * 1024 * 1024,
  /** What the reader inflates a JSON entry to at most. */
  inflatedBytes: 4 * 1024 * 1024,
  uploadBytes: 512 * 1024 * 1024,
  passphraseMin: 12,
  passphraseMax: 1024,
  /** Downloads with volume data that may run at once on a panel (one per service). */
  dataExports: 3,
  /** A download the browser stops reading for this long ends, and the service starts again. */
  exportIdleMinutes: 5,
  /** A download never keeps its service stopped longer than this. */
  exportStoppedHours: 12,
  /** A volume's upload with no part for this long ends; it starts over. */
  uploadIdleMinutes: 10,
  /** Data that unpacks to more than this many times its size asks for a confirmation. */
  confirmRatio: 200,
  /** More than gzip can reach: a file saying so is refused. */
  maxRatio: 1100,
} as const;

/**
 * What the agent may unpack from a volume archive the manifest describes:
 * a little more than the bytes counted at export (a file that shrank while
 * it was read is padded with zeros), and entries likewise; 2,000,000 when
 * the exporting agent did not count them.
 */
export function volumeImportLimits(entry: { unpackedBytes?: number; files?: number | null }): { maxBytes: number; maxEntries: number } {
  const bytes = entry.unpackedBytes ?? 0;
  return {
    maxBytes: Math.ceil(bytes * 1.01) + 16 * 1024 * 1024,
    maxEntries: typeof entry.files === "number" && entry.files > 0 ? Math.ceil(entry.files * 1.01) + 1000 : 2_000_000,
  };
}

/** Lower-case hex SHA-256. */
export const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const SecretsMode = Type.Union([Type.Literal("encrypted"), Type.Literal("omitted")], {
  description:
    "encrypted: settings and secret values are in secrets.enc under a passphrase. omitted: settings in clear, secret values left out.",
});

/** Names an entry may have, where `<service>` is a service name. */
export const entryPatterns = {
  readme: "README.txt",
  manifest: "manifest.json",
  signature: "manifest.sig",
  secrets: "secrets.enc",
  service: /^services\/([a-z0-9]([a-z0-9-]*[a-z0-9])?)\/service\.json$/,
  upload: /^services\/([a-z0-9]([a-z0-9-]*[a-z0-9])?)\/source\/upload\.tar\.gz$/,
  volume: /^services\/([a-z0-9]([a-z0-9-]*[a-z0-9])?)\/volumes\/([a-z0-9][a-z0-9_-]*)\.tar\.gz$/,
} as const;

/** Whether `name` is one of the entry names the format allows. */
export function isExportEntryName(name: string): boolean {
  return (
    name === entryPatterns.readme ||
    name === entryPatterns.manifest ||
    name === entryPatterns.signature ||
    name === entryPatterns.secrets ||
    entryPatterns.service.test(name) ||
    entryPatterns.upload.test(name) ||
    entryPatterns.volume.test(name)
  );
}

export const ManifestEntryV1 = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 300 }),
  /** Bytes of the entry uncompressed. */
  size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  sha256: Sha256,
  /** Volume archives: file bytes archived (ExportVolume's count). */
  unpackedBytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** Volume archives: archive entries; null from agents that do not count them. */
  files: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});

const Count = Type.Integer({ minimum: 0, maximum: 100_000 });

/** What the file holds, in clear even when encrypted, for the import page before the passphrase. */
export const ServiceCounts = Type.Object({
  envKeys: Count,
  fileMounts: Count,
  domains: Count,
  volumes: Count,
  cronJobs: Count,
  uptimeChecks: Count,
});

export const PortableManifestV1 = Type.Object({
  format: Type.Literal(exportFormat),
  formatVersion: Type.Integer({ minimum: 1, maximum: 1000 }),
  panel: Type.Object({
    version: Type.String({ maxLength: 100 }),
    /** The exporting panel's id: "same panel" tells imports to keep schedules and alerts off by default. */
    id: Type.String({ maxLength: 64 }),
  }),
  exportedAt: Timestamp,
  secrets: SecretsMode,
  /** Features the file uses that an older importer would not read in full; see knownFeatures. */
  requires: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 50 }),
  services: Type.Array(
    Type.Object({
      name: ServiceName,
      kind: ServiceKind,
      /** "services/<name>/". */
      path: Type.String({ maxLength: 100 }),
      /** Agent version of the node it ran on, for bug reports about its data. */
      agentVersion: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
      counts: ServiceCounts,
    }),
    { minItems: 1, maxItems: 1 },
  ),
  entries: Type.Array(ManifestEntryV1, { maxItems: transferLimits.entries }),
});
export type PortableManifestV1 = Static<typeof PortableManifestV1>;

export const ManifestSignature = Type.Object({
  alg: Type.Literal("HMAC-SHA256"),
  value: Sha256,
});

/** The source without panel-local ids; sourceAccess says what read it. */
export const PortableSource = Type.Union([
  Type.Object({
    type: Type.Literal("github"),
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    branch: GitBranch,
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal("git"), url: GitUrl, branch: GitBranch, deployOnPush: Type.Boolean() }),
  Type.Object({
    type: Type.Literal("provider"),
    provider: GitProviderKind,
    repo: RepoFullPath,
    branch: GitBranch,
    deployOnPush: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal("image"), image: Type.String({ minLength: 1, maxLength: 300, pattern: "^\\S+$" }) }),
  Type.Object({ type: Type.Literal("inline") }),
  Type.Object({ type: Type.Literal("upload"), fileName: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]) }),
  Type.Object({ type: Type.Literal("none") }),
]);

/** What read the source on the old panel, as something another panel can look up. */
export const SourceAccess = Type.Union([
  Type.Object({ via: Type.Literal("githubInstallation"), account: Type.String({ minLength: 1, maxLength: 100 }) }),
  Type.Object({ via: Type.Literal("githubAccount"), login: Type.String({ minLength: 1, maxLength: 100 }) }),
  Type.Object({
    via: Type.Literal("gitCredential"),
    name: Type.String({ maxLength: 200 }),
    kind: Type.Union([Type.Literal("token"), Type.Literal("ssh_key")]),
    host: Type.String({ minLength: 1, maxLength: 253 }),
    username: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    fingerprint: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  }),
  Type.Object({
    via: Type.Literal("gitProvider"),
    provider: GitProviderKind,
    url: Type.String({ minLength: 1, maxLength: 300 }),
    workspace: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  }),
  Type.Object({
    via: Type.Literal("registry"),
    name: Type.String({ maxLength: 200 }),
    server: Type.String({ minLength: 1, maxLength: 253 }),
    username: Type.String({ maxLength: 200 }),
  }),
  Type.Null(),
]);

export const PortableSpec = Type.Object({
  source: PortableSource,
  /** The build node is buildNode, by name. */
  build: Type.Omit(BuildSettings, ["buildNodeId"]),
  container: ContainerSettings,
  ports: Type.Array(Port, { maxItems: 20 }),
  healthCheck: Type.Union([HealthCheck, Type.Null()]),
  crashPolicy: CrashPolicy,
  resources: Resources,
  deploy: DeployStrategy,
  cron: Type.Union([CronSettings, Type.Null()]),
  stickySessions: Type.Boolean(),
  watchPaths: WatchPaths,
  /** Imported with previews off. */
  previews: Type.Object({ enabled: Type.Boolean(), maxPreviews: Type.Integer({ minimum: 1, maximum: 50 }) }),
});

/** Strict objects: a key this panel does not know makes the item fail, so it is skipped, never imported weaker. */
const strict = { additionalProperties: false } as const;

export const PortableDomain = Type.Object({
  host: Hostname,
  pathPrefix: PathPrefix,
  stripPrefix: Type.Boolean(),
  targetPort: ContainerPort,
  https: HttpsMode,
  redirectToHttps: Type.Boolean(),
  /** From the old node's wildcard domain: listed, not recreated (the import offers a new one). */
  auto: Type.Boolean(),
  isPrimary: Type.Boolean(),
  forward: Type.Union([DomainForward, Type.Null()]),
  middlewares: Type.Object(
    {
      ipAllowList: Type.Array(Cidr, { maxItems: 100 }),
      rateLimit: Type.Union([DomainRateLimit, Type.Null()]),
      redirects: Type.Array(DomainRedirect, { maxItems: 50 }),
      /** User names; the bcrypt hashes are in secrets.enc. */
      basicAuthUsers: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 }),
    },
    strict,
  ),
  /** The certificate and key are in secrets.enc. */
  customCertificate: Type.Boolean(),
});

export const PortableExposure = Type.Object(
  {
    kind: Type.Literal("database"),
    listenPort: Type.Integer({ minimum: 0, maximum: 65535 }),
    allowedCidrs: Type.Array(Cidr, { maxItems: 100 }),
    tls: Type.Boolean(),
  },
  strict,
);

export const PortableCronJob = Type.Object({
  name: JobName,
  schedule: CronSchedule,
  timeZone: TimeZone,
  command: Command,
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
  concurrency: CronConcurrency,
  enabled: Type.Boolean(),
});

export const PortableUptimeCheck = Type.Object({
  name: CheckSettings.name,
  url: CheckSettings.url,
  method: CheckSettings.method,
  expectedStatus: CheckSettings.expectedStatus,
  intervalSeconds: CheckSettings.intervalSeconds,
  timeoutMs: CheckSettings.timeoutMs,
  failureThreshold: CheckSettings.failureThreshold,
  keyword: CheckSettings.keyword,
  maxLatencyMs: CheckSettings.maxLatencyMs,
  enabled: Type.Boolean(),
});

export const PortableAlertRule = Type.Object({
  event: AlertRuleEvent,
  enabled: Type.Boolean(),
  /** Channels are panel-wide: matched by name and kind on import. */
  channels: Type.Array(Type.Object({ name: Type.String({ maxLength: 200 }), kind: ChannelKind }), { maxItems: 50 }),
});

export const PortableBackupPolicy = Type.Object({
  target: Type.Union([Type.Literal("database"), Type.Literal("volume")]),
  /** Volume backups: the volume's name. */
  volume: Type.Union([VolumeName, Type.Null()]),
  schedule: Type.String({ minLength: 9, maxLength: 100, pattern: "^\\S+( \\S+){4}$" }),
  keepLast: Type.Integer({ minimum: 1, maximum: 1000 }),
  stopService: Type.Boolean(),
  enabled: Type.Boolean(),
  /** Database backups of chosen databases or tables (0.2.16); left out is everything. Older panels ignore it and back up everything. */
  selection: Type.Optional(BackupSelection),
  /** Destinations are panel-wide (their keys too): matched by name on import. */
  destination: Type.Object({
    name: Type.String({ maxLength: 200 }),
    provider: DestinationProvider,
    bucket: Type.String({ maxLength: 200 }),
  }),
});

const MountPath = Type.String({ minLength: 1, maxLength: 500, pattern: "^/" });

/** services/<name>/service.json: every setting of one service, never a secret value. */
export const PortableServiceV1 = Type.Object({
  name: ServiceName,
  kind: ServiceKind,
  notes: Type.String({ maxLength: 20_000 }),
  templateSlug: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
  /** It was stopped when exported: the import's "deploy when ready" starts unticked. */
  stopped: Type.Boolean(),
  spec: PortableSpec,
  sourceAccess: SourceAccess,
  /** The node that built it, by name. */
  buildNode: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
  placements: Type.Array(Type.Object({ node: Type.String({ maxLength: 100 }), replicas: Type.Integer({ minimum: 1, maximum: 32 }) }), {
    maxItems: 64,
  }),
  volumes: Type.Array(
    Type.Object({
      name: VolumeName,
      mountPath: MountPath,
      readOnly: Type.Boolean(),
      /** The volume's archive in the file; null when its data was not exported. */
      data: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    }),
    { maxItems: transferLimits.volumesPerService },
  ),
  /** The contents are in secrets.enc. */
  fileMounts: Type.Array(
    Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), mountPath: MountPath, readOnly: Type.Boolean() }),
    {
      maxItems: 50,
    },
  ),
  env: Type.Object({
    /** Variable names; the values are in secrets.enc. */
    keys: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 2000 }),
    /** Services its ${{name.VAR}} references name. */
    services: Type.Array(ServiceName, { maxItems: 200 }),
    /** Shared project variables it references (${{project.NAME}}); their values are in secrets.enc. */
    shared: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 500 }),
  }),
  database: Type.Union([
    Type.Object({
      engine: Type.String({ maxLength: 40 }),
      version: Type.String({ maxLength: 40 }),
      variant: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
      databaseName: Type.String({ maxLength: 100 }),
      /** Inside and through the exposed port alike (0.2.9's exposure). */
      adminUser: Type.String({ maxLength: 100 }),
      /**
       * The old exposed user of a database from before 0.2.9 that its panel
       * has not retired yet (a name, never its password). An import with the
       * database's data keeps it so its node retires that login in the
       * copied data; without the data it is ignored. Exposure itself uses
       * adminUser.
       */
      exposedUser: Type.Optional(Type.String({ maxLength: 100 })),
      webUiIdleMinutes: Type.Integer({ minimum: 0, maximum: 10_000 }),
    }),
    Type.Null(),
  ]),
  box: Type.Union([
    Type.Object({
      repository: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      idleMinutes: Type.Integer({ minimum: 0, maximum: 100_000 }),
    }),
    Type.Null(),
  ]),
  domains: Type.Array(PortableDomain, { maxItems: 100 }),
  access: Type.Union([Type.Object({ closeWhenDomainLive: Type.Boolean(), redirectToPrimary: Type.Boolean() }, strict), Type.Null()]),
  exposures: Type.Array(PortableExposure, { maxItems: 10 }),
  /** Imported switched off: two connectors on one token would split traffic between the panels. */
  tunnel: Type.Union([
    Type.Object({
      mode: TunnelMode,
      targetPort: ContainerPort,
      hostname: Type.Union([Hostname, Type.Null()]),
      /** The service's own token is in secrets.enc. */
      hasToken: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  maintenance: Type.Union([
    Type.Object({ enabled: Type.Boolean(), message: Message, html: Type.Union([PageHtml, Type.Null()]) }),
    Type.Null(),
  ]),
  cronJobs: Type.Array(PortableCronJob, { maxItems: 100 }),
  uptimeChecks: Type.Array(PortableUptimeCheck, { maxItems: 10 }),
  alerts: Type.Array(PortableAlertRule, { maxItems: 50 }),
  backups: Type.Array(PortableBackupPolicy, { maxItems: 50 }),
  /** It had a deploy trigger URL; the token is stored hashed, so the import makes a new one. */
  deployTrigger: Type.Boolean(),
  /** What served when it was exported; a first deploy can build the same commit or pin the image digest. */
  live: Type.Union([
    Type.Object({
      commitSha: Type.Union([Type.String({ pattern: "^[0-9a-f]{7,64}$" }), Type.Null()]),
      branch: Type.Union([Type.String({ maxLength: 250 }), Type.Null()]),
      /** Image sources only: the digest that ran. */
      imageDigest: Type.Union([Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }), Type.Null()]),
      deployedAt: Type.Union([Timestamp, Type.Null()]),
    }),
    Type.Null(),
  ]),
  upload: Type.Union([
    Type.Object({
      fileName: Type.String({ maxLength: 120 }),
      sizeBytes: Type.Integer({ minimum: 1, maximum: transferLimits.uploadBytes }),
      /** "services/<name>/source/upload.tar.gz". */
      entry: Type.String({ maxLength: 300 }),
    }),
    Type.Null(),
  ]),
});
export type PortableServiceV1 = Static<typeof PortableServiceV1>;

const SecretMap = Type.Record(Type.String({ maxLength: 200 }), Type.String({ maxLength: 2 * 1024 * 1024 }));

/** The plaintext inside secrets.enc. */
export const PortableSecretsV1 = Type.Object({
  services: Type.Record(
    ServiceName,
    Type.Object({
      /** The service's settings (PortableServiceV1): with a passphrase they are not in the zip in clear. */
      doc: Type.Unknown(),
      env: Type.String({ maxLength: 2 * 1024 * 1024 }),
      /** File mount contents by mount name. */
      fileMounts: SecretMap,
      /**
       * service_secrets by name (database logins): admin_password. Files
       * from builds before 0.2.9's exposure may also carry exposed_password,
       * which an import ignores.
       */
      databaseSecrets: SecretMap,
      /** By "<host><pathPrefix>". */
      domains: Type.Record(
        Type.String({ maxLength: 500 }),
        Type.Object({
          certificate: Type.Optional(
            Type.Object({ certPem: Type.String({ maxLength: 100_000 }), keyPem: Type.String({ maxLength: 100_000 }) }),
          ),
          basicAuth: Type.Optional(
            Type.Array(Type.Object({ username: Type.String({ maxLength: 100 }), hash: Type.String({ maxLength: 100 }) }), { maxItems: 50 }),
          ),
        }),
      ),
      tunnelToken: Type.Union([Type.String({ maxLength: 4096 }), Type.Null()]),
      /** Shared project variables the env references, by name. */
      shared: SecretMap,
      /** With "Include the git credential and registry login". */
      sourceCredential: Type.Union([
        Type.Object({
          kind: Type.Literal("gitCredential"),
          secret: Type.String({ maxLength: 100_000 }),
          knownHosts: Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()]),
          publicKey: Type.Union([Type.String({ maxLength: 10_000 }), Type.Null()]),
        }),
        Type.Object({ kind: Type.Literal("registry"), password: Type.String({ maxLength: 10_000 }) }),
        Type.Null(),
      ]),
    }),
  ),
});
export type PortableSecretsV1 = Static<typeof PortableSecretsV1>;

const B64Url = (bytes?: number) =>
  Type.String({ pattern: "^[A-Za-z0-9_-]*$", ...(bytes ? { maxLength: Math.ceil((bytes * 4) / 3) } : {}) });

/** secrets.enc: scrypt + HKDF-SHA256 + AES-256-GCM. */
export const SecretsEnvelopeV1 = Type.Object({
  v: Type.Literal(1),
  kdf: Type.Object({
    name: Type.Literal("scrypt"),
    N: Type.Integer({ minimum: 1 }),
    r: Type.Integer({ minimum: 1 }),
    p: Type.Integer({ minimum: 1 }),
    salt: B64Url(64),
    /** 16 bytes of an HMAC under a key from the passphrase: tells a wrong passphrase from a damaged file. */
    check: B64Url(32),
  }),
  cipher: Type.Literal("aes-256-gcm"),
  iv: B64Url(64),
  tag: B64Url(64),
  data: B64Url(),
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;
const projectScope = (input: { projectId: string }) => input.projectId;
const exportPermission = permission.service("services.export", serviceScope, { adminOnly: true });
const importPermission = permission.project("services.import", projectScope, { adminOnly: true });

/** Why a service cannot be exported now. */
export const ExportBlock = Type.Union([
  Type.Literal("compose"),
  Type.Literal("protected"),
  Type.Literal("panel"),
  Type.Literal("preview"),
  Type.Literal("copying"),
  Type.Literal("moving"),
  Type.Literal("importing"),
  Type.Literal("tooLarge"),
]);

/** Why volume data cannot go in an export now (settings still can). */
export const ExportDataBlock = Type.Union([
  /** No node holds it, or its node is offline. */
  Type.Literal("noNode"),
  Type.Literal("offline"),
  Type.Literal("agentTooOld"),
  /** A missing permission (files.read; databases.credentials for a database's logins; services.control to stop it). */
  Type.Literal("permission"),
  /** Another download of its data runs. */
  Type.Literal("exporting"),
  /** As many downloads with data run on the panel as it allows (transferLimits.dataExports). */
  Type.Literal("busy"),
]);

export const exportPreview = defineOp({
  id: "serviceTransfer.exportPreview",
  kind: "query",
  summary: "Show what an export of a service holds",
  description:
    "Lists what serviceTransfer.export would put in the file: environment variables, file mounts, domains, cron jobs, uptime checks, alerts, backup schedules, the maintenance page, tunnel, deploy trigger and the uploaded archive; what is left out and why; and anything that blocks an export (compose stacks and their members, protected services, the panel, previews, a copy or move that runs). Owners and admins only.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    name: ServiceName,
    kind: ServiceKind,
    blockers: Type.Array(Type.Object({ reason: ExportBlock, message: Type.String() })),
    includes: Type.Object({
      envKeys: Count,
      fileMounts: Count,
      domains: Type.Array(
        Type.Object({
          host: Type.String(),
          pathPrefix: Type.String(),
          auto: Type.Boolean(),
          customCertificate: Type.Boolean(),
          basicAuth: Type.Boolean(),
        }),
      ),
      cronJobs: Count,
      uptimeChecks: Count,
      alerts: Count,
      backups: Count,
      exposures: Count,
      tunnel: Type.Boolean(),
      maintenance: Type.Boolean(),
      deployTrigger: Type.Boolean(),
      sharedVariables: Type.Array(Type.String()),
      upload: Type.Union([Type.Object({ fileName: Type.String(), sizeBytes: Type.Integer({ minimum: 0 }) }), Type.Null()]),
    }),
    /** Volumes; their data goes in the file when export lists them. */
    volumes: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
    data: Type.Object({
      /** Why volume data cannot go in the file now; null: it can. */
      blocker: Type.Union([Type.Object({ reason: ExportDataBlock, message: Type.String() }), Type.Null()]),
      /** A database: all of its data or none, it is always stopped while its data is read, and its logins need a passphrase. */
      database: Type.Boolean(),
      /** It runs now, so reading its data stops it until the download ends (unless stopService is off, never for a database). */
      running: Type.Boolean(),
      node: Type.Union([Type.Object({ id: Id, name: Type.String() }), Type.Null()]),
    }),
    /** The git credential or registry login the source uses, which includeSourceLogin adds (encrypted). */
    sourceLogin: Type.Union([
      Type.Object({ kind: Type.Union([Type.Literal("gitCredential"), Type.Literal("registry")]), name: Type.String() }),
      Type.Null(),
    ]),
    leftOut: Type.Array(Type.Object({ what: Type.String(), why: Type.String() })),
  }),
  permission: exportPermission,
  mcp: false,
  audit: false,
});

export const exportService = defineOp({
  id: "serviceTransfer.export",
  kind: "mutation",
  summary: "Export a service to a .zip file",
  description:
    "Builds an export of a service and returns a one-minute download link for the .zip. With secrets encrypted (a passphrase of 12 to 1024 characters the panel cannot recover) the settings and every secret value are inside secrets.enc; with secrets omitted the settings are in clear (commands and URLs as they are) and secret values are left out. includeSourceLogin adds the git credential or registry login the source uses (needs git.manage or registries.manage). volumes lists the volumes whose data goes in the file (needs files.read; a database all or none, with a passphrase and databases.credentials): the download reads them from the node as it goes, and with stopService (the default, always for a database) the service is stopped before the first byte and started again when the download ends, fails, stalls for 5 minutes or is stopped with serviceTransfer.cancelExport. Uploaded archives and volume data are not encrypted. Needs a recent sign-in. Owners and admins only.",
  input: Type.Object({
    serviceId: Id,
    secrets: SecretsMode,
    passphrase: Type.Optional(Type.String({ minLength: transferLimits.passphraseMin, maxLength: transferLimits.passphraseMax })),
    /** Put the git credential or registry login the source uses in secrets.enc (needs git.manage or registries.manage). */
    includeSourceLogin: Type.Optional(Type.Boolean()),
    /** Volumes whose data goes in the file; none when left out. */
    volumes: Type.Optional(Type.Array(VolumeName, { maxItems: transferLimits.volumesPerService })),
    /** Stop the service while its volumes are read (default on; a database always stops). Needs services.control. */
    stopService: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    exportId: Id,
    /** "<service>-<yyyymmdd-hhmm>.<slug>.zip". */
    fileName: Type.String(),
    download: StreamTicket,
    /** The download stops the service until it ends. */
    stopsService: Type.Boolean(),
  }),
  sensitive: { input: ["passphrase"], output: ["download"] },
  permission: exportPermission,
  mcp: false,
  audit: true,
});

export const exportLink = defineOp({
  id: "serviceTransfer.exportLink",
  kind: "mutation",
  summary: "Get a new download link for an export",
  description:
    "Issues a new one-minute download link for an export whose download has not started (it stays ready for 2 minutes after serviceTransfer.export). Needs a recent sign-in. Owners and admins only.",
  input: Type.Object({ serviceId: Id, exportId: Id }),
  output: Type.Object({ fileName: Type.String(), download: StreamTicket }),
  sensitive: { output: ["download"] },
  permission: exportPermission,
  mcp: false,
  audit: true,
});

export const cancelExport = defineOp({
  id: "serviceTransfer.cancelExport",
  kind: "mutation",
  summary: "Stop an export's download",
  description:
    "Stops the download of an export that runs (or whose link was not used yet) and starts the service again when the download stopped it. Owners and admins only.",
  input: Type.Object({ serviceId: Id, exportId: Id }),
  output: Type.Object({ cancelled: Type.Boolean() }),
  permission: exportPermission,
  mcp: false,
  audit: true,
});

export const ImportStatus = Type.Union([
  Type.Literal("previewing"),
  Type.Literal("receiving"),
  Type.Literal("done"),
  Type.Literal("failed"),
]);

/** What the owner picks on the review page; every field is optional and the preview fills in defaults. */
export const ImportChoices = Type.Object({
  name: Type.Optional(ServiceName),
  nodeId: Type.Optional(Id),
  /** What reads the source here: a kind and the id of the row (none: import without it). */
  sourceAccess: Type.Optional(
    Type.Object({
      kind: Type.Union([
        Type.Literal("githubInstallation"),
        Type.Literal("githubAccount"),
        Type.Literal("gitCredential"),
        Type.Literal("gitProvider"),
        Type.Literal("registry"),
        Type.Literal("createFromFile"),
        Type.Literal("none"),
      ]),
      id: Type.Optional(Id),
    }),
  ),
  /** live: build the exported commit first (falls back to the branch head). head: the branch head. */
  commit: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("head")])),
  /** Image sources: deploy the exported digest. */
  pinDigest: Type.Optional(Type.Boolean()),
  /** Deploy once everything is in. */
  deployWhenReady: Type.Optional(Type.Boolean()),
  /** Push deploys arrive off unless this is on. */
  deployOnPush: Type.Optional(Type.Boolean()),
  domains: Type.Optional(
    Type.Array(Type.Object({ host: Hostname, pathPrefix: PathPrefix, action: Type.Union([Type.Literal("add"), Type.Literal("skip")]) }), {
      maxItems: 100,
    }),
  ),
  /** Add an automatic domain from the node's wildcard record. */
  autoDomain: Type.Optional(Type.Boolean()),
  upload: Type.Optional(Type.Boolean()),
  /** Volumes whose data in the file goes up after the service is created (a database: all or none). */
  volumes: Type.Optional(Type.Array(VolumeName, { maxItems: transferLimits.volumesPerService })),
  /** The owner saw how much space the data takes on the node and confirmed it. */
  confirmData: Type.Optional(Type.Boolean()),
  sharedVariables: Type.Optional(Type.Union([Type.Literal("addMissing"), Type.Literal("overwrite"), Type.Literal("skip")])),
  cronJobs: Type.Optional(Type.Union([Type.Literal("asInFile"), Type.Literal("disabled")])),
  uptimeChecks: Type.Optional(Type.Union([Type.Literal("asInFile"), Type.Literal("disabled"), Type.Literal("skip")])),
  alerts: Type.Optional(Type.Union([Type.Literal("mapByName"), Type.Literal("skip")])),
  backups: Type.Optional(Type.Union([Type.Literal("mapByName"), Type.Literal("disabled"), Type.Literal("skip")])),
  /** Database listeners by listen port. */
  exposures: Type.Optional(
    Type.Array(
      Type.Object({
        listenPort: Type.Integer({ minimum: 0, maximum: 65535 }),
        action: Type.Union([Type.Literal("add"), Type.Literal("skip")]),
      }),
      {
        maxItems: 10,
      },
    ),
  ),
});
export type ImportChoices = Static<typeof ImportChoices>;

export const ImportIssue = Type.Object({ reason: Type.String(), message: Type.String(), field: Type.Optional(Type.String()) });

export const ImportPreview = Type.Object({
  importId: Id,
  projectId: Id,
  status: ImportStatus,
  file: Type.Object({
    panelVersion: Type.String(),
    exportedAt: Timestamp,
    secrets: SecretsMode,
    /** From this panel (manifest panel.id). */
    samePanel: Type.Boolean(),
    /** Settings this panel does not know, by path; skipped. */
    unknownSettings: Type.Array(Type.String()),
  }),
  service: Type.Object({ name: ServiceName, kind: ServiceKind, source: SourceSummary }),
  /** Normalised: every field set. */
  choices: ImportChoices,
  /** The import refuses until these are gone. */
  blockers: Type.Array(ImportIssue),
  /** Choices the owner still has to make. */
  needs: Type.Array(ImportIssue),
  /** Goes ahead, but says it. */
  warnings: Type.Array(ImportIssue),
  nodes: Type.Array(Type.Object({ id: Id, name: Type.String(), online: Type.Boolean() })),
  env: Type.Object({
    keys: Type.Array(Type.String()),
    /** Without values (secrets omitted): they need values after the import. */
    empty: Type.Boolean(),
    references: Type.Array(ReferenceEffect),
    /** ${{name.VAR}} references that read an existing service here. */
    readsFrom: Type.Array(Type.Object({ key: Type.String(), service: ServiceName, kind: ServiceKind })),
    missingServices: Type.Array(Type.String()),
    shared: Type.Array(
      Type.Object({
        name: Type.String(),
        /** missing here; same value; differs here; unknown (no value in the file). */
        state: Type.Union([Type.Literal("missing"), Type.Literal("same"), Type.Literal("differs"), Type.Literal("noValue")]),
      }),
    ),
  }),
  domains: Type.Array(
    Type.Object({
      host: Type.String(),
      pathPrefix: Type.String(),
      https: Type.String(),
      primary: Type.Boolean(),
      status: Type.Union([
        Type.Literal("free"),
        Type.Literal("usedHere"),
        Type.Literal("usedHidden"),
        Type.Literal("needsPassword"),
        Type.Literal("certificateDropped"),
        Type.Literal("auto"),
        Type.Literal("invalid"),
      ]),
      action: Type.Union([Type.Literal("add"), Type.Literal("skip")]),
      basicAuthUsers: Type.Array(Type.String()),
      message: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  autoDomain: Type.Object({ host: Type.Union([Type.String(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]) }),
  /** The domain that becomes primary, after skips. */
  primaryDomain: Type.Union([Type.String(), Type.Null()]),
  source: Type.Object({
    access: Type.Object({
      picked: Type.Union([Type.Object({ kind: Type.String(), id: Type.Union([Id, Type.Null()]), name: Type.String() }), Type.Null()]),
      options: Type.Array(Type.Object({ kind: Type.String(), id: Type.Union([Id, Type.Null()]), name: Type.String() })),
      /** What the file says read it. */
      wanted: Type.Union([Type.String(), Type.Null()]),
    }),
    commitSha: Type.Union([Type.String(), Type.Null()]),
    imageDigest: Type.Union([Type.String(), Type.Null()]),
  }),
  extras: Type.Object({
    cronJobs: Count,
    uptimeChecks: Count,
    maintenance: Type.Boolean(),
    tunnel: Type.Boolean(),
    deployTrigger: Type.Boolean(),
    exposures: Type.Array(
      Type.Object({
        listenPort: Type.Integer(),
        allowedCidrs: Type.Array(Type.String()),
        clash: Type.Boolean(),
        action: Type.String(),
        /**
         * Why it cannot be added here, as databases.setExposure would refuse
         * it (a version without TLS, a node whose agent is too old to keep
         * the port TLS only); null when it can.
         */
        refusal: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    alerts: Type.Array(
      Type.Object({ event: Type.String(), channels: Type.Array(Type.Object({ name: Type.String(), mapped: Type.Boolean() })) }),
    ),
    backups: Type.Array(
      Type.Object({
        target: Type.String(),
        volume: Type.Union([Type.String(), Type.Null()]),
        destination: Type.String(),
        mapped: Type.Boolean(),
      }),
    ),
  }),
  data: Type.Object({
    volumes: Type.Array(
      Type.Object({
        name: Type.String(),
        mountPath: Type.String(),
        /** The file has its data. */
        inFile: Type.Boolean(),
        /** The archive's size in the file. */
        sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        /** File bytes it unpacks to, as the exporting agent counted. */
        unpackedBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        /** Its data goes up after the import (choices.volumes). */
        include: Type.Boolean(),
      }),
    ),
    upload: Type.Union([Type.Object({ fileName: Type.String(), sizeBytes: Type.Integer({ minimum: 0 }) }), Type.Null()]),
    /** Room the chosen data may take on the node (the agent's limit), and what the node last reported free. */
    neededBytes: Type.Integer({ minimum: 0 }),
    node: Type.Object({
      freeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      totalBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
  }),
  /** What the import leaves behind and why. */
  skipped: Type.Array(Type.Object({ what: Type.String(), why: Type.String() })),
  expiresAt: Timestamp,
});

const ServiceJsonInput = Type.Object({
  path: Type.String({ maxLength: 300 }),
  json: Type.String({ maxLength: transferLimits.documentBytes }),
});

export const importBegin = defineOp({
  id: "serviceTransfer.importBegin",
  kind: "mutation",
  summary: "Start importing an exported service",
  description:
    "Checks an exported file's small entries (the browser reads them from the .zip and sends their text): manifest.json, manifest.sig and secrets.enc with its passphrase, or service.json when secret values were left out. Every size, name and sha256 is checked against the manifest, and the passphrase must open secrets.enc and verify the manifest. Nothing is created yet: it returns an import id and the preview to review. Owners and admins only.",
  input: Type.Object({
    projectId: Id,
    manifest: Type.String({ maxLength: transferLimits.manifestBytes }),
    signature: Type.Optional(Type.String({ maxLength: 1000 })),
    services: Type.Optional(Type.Array(ServiceJsonInput, { maxItems: 1 })),
    secretsEnc: Type.Optional(Type.String({ maxLength: transferLimits.documentBytes * 1.5 })),
    passphrase: Type.Optional(Type.String({ minLength: 1, maxLength: transferLimits.passphraseMax })),
  }),
  output: ImportPreview,
  sensitive: { input: ["passphrase", "secretsEnc", "services", "manifest", "signature"] },
  permission: importPermission,
  mcp: false,
  audit: true,
  rateLimit: "strict",
  maxBodyBytes: 4 * 1024 * 1024,
});

const ImportRef = { projectId: Id, importId: Id };

export const setChoices = defineOp({
  id: "serviceTransfer.setChoices",
  kind: "mutation",
  summary: "Change the choices of an import",
  description:
    "Saves what the review page picked for an import (name, node, what reads the source, the first deploy, domains, schedules, alerts, backups, listeners) and returns the preview with them. Basic auth passwords are not choices: they go with serviceTransfer.import only. Owners and admins only.",
  input: Type.Object({ ...ImportRef, choices: ImportChoices }),
  output: ImportPreview,
  permission: importPermission,
  mcp: false,
  audit: true,
});

export const importPreview = defineOp({
  id: "serviceTransfer.importPreview",
  kind: "query",
  summary: "Show what an import would create",
  description:
    "Returns the preview of an import with its saved choices: what blocks it, the choices still needed, warnings, the environment's references, domains and their status, what reads the source, schedules, alerts, backups, listeners and what is left behind. Owners and admins only.",
  input: Type.Object(ImportRef),
  output: ImportPreview,
  permission: importPermission,
  mcp: false,
  audit: false,
});

export const importService = defineOp({
  id: "serviceTransfer.import",
  kind: "mutation",
  summary: "Create the service from an import",
  description:
    "Creates the service in the project from an import, stopped, with the saved choices, once nothing blocks it and no choice is open. passwords sets new basic auth passwords for domains whose file had none (secret values left out). The uploaded archive and the chosen volumes' data go up next (serviceTransfer.uploadTicket); the service deploys when everything is in and deployWhenReady is on. Needs a recent sign-in. Owners and admins only.",
  input: Type.Object({
    ...ImportRef,
    passwords: Type.Optional(
      Type.Array(
        Type.Object({
          host: Hostname,
          pathPrefix: PathPrefix,
          username: Type.String({ minLength: 1, maxLength: 100 }),
          password: Type.String({ minLength: 8, maxLength: 200 }),
        }),
        { maxItems: 100 },
      ),
    ),
  }),
  output: Type.Object({
    service: ServiceDetail,
    importId: Id,
    /** Entries still to upload. */
    pending: Type.Array(
      Type.Object({
        entry: Type.String(),
        sizeBytes: Type.Integer({ minimum: 0 }),
        kind: Type.Union([Type.Literal("upload"), Type.Literal("volume")]),
        volume: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    /** The new deploy trigger URL, shown once. */
    deployTrigger: Type.Union([Type.Object({ url: Type.String() }), Type.Null()]),
    skipped: Type.Array(Type.Object({ what: Type.String(), why: Type.String() })),
  }),
  sensitive: { input: ["passwords"], output: ["deployTrigger"] },
  permission: importPermission,
  mcp: false,
  audit: true,
});

export const ImportEntry = Type.Object({
  path: Type.String(),
  kind: Type.Union([Type.Literal("upload"), Type.Literal("volume")]),
  /** Volumes: its name. */
  volume: Type.Union([Type.String(), Type.Null()]),
  size: Type.Integer({ minimum: 0 }),
  sha256: Sha256,
  status: Type.Union([Type.Literal("pending"), Type.Literal("done"), Type.Literal("failed")]),
  /** Bytes the panel has; the next part starts here. */
  received: Type.Integer({ minimum: 0 }),
  error: Type.Union([Type.String(), Type.Null()]),
});

/** An entry goes up in parts of at most this many bytes (under Cloudflare's and Bun's request body limits). */
export const uploadPartBytes = 32 * 1024 * 1024;

export const uploadTicket = defineOp({
  id: "serviceTransfer.uploadTicket",
  kind: "mutation",
  summary: "Get an upload link for a part of an import's archive",
  description:
    "Returns a one-minute link to PUT one part (at most 32 MiB) of a pending entry of an import (the uploaded archive of an upload app, or a volume's data), starting at `offset`, which must be the bytes the panel already has (getImport's received; 0 starts over). The uploaded archive collects on the panel; a volume's parts go straight on to its node while the panel keeps the stream open (10 minutes without a part start it over). Once the last part is in, the panel checks the whole entry's size and sha256 against the manifest (and the node checks the volume's again) before it keeps it. Owners and admins only.",
  input: Type.Object({
    ...ImportRef,
    entry: Type.String({ maxLength: 300 }),
    offset: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  output: StreamTicket,
  sensitive: { output: ["url", "ticket"] },
  permission: importPermission,
  mcp: false,
  audit: true,
});

export const getImport = defineOp({
  id: "serviceTransfer.getImport",
  kind: "query",
  summary: "Get the state of an import",
  description:
    "Returns an import's status, the service it created and each entry still to upload or done, so a reloaded page can go on. Owners and admins only.",
  input: Type.Object(ImportRef),
  output: Type.Object({
    importId: Id,
    status: ImportStatus,
    serviceId: Type.Union([Id, Type.Null()]),
    /** sha256 of manifest.json, so a page can check it has the same file before it uploads. */
    manifestSha256: Sha256,
    entries: Type.Array(ImportEntry),
    deployWhenReady: Type.Boolean(),
    expiresAt: Timestamp,
  }),
  permission: importPermission,
  mcp: false,
  audit: false,
});

export const discardImport = defineOp({
  id: "serviceTransfer.discardImport",
  kind: "destructive",
  summary: "Discard an import",
  description:
    "Throws an import away. While it still waits for its archive, the service it created is deleted too (with what arrived), unless it is protected or has deployments (CONFLICT reason protected or deployed); a failed or done import only loses its record and the service stays. Owners and admins only.",
  input: Type.Object(ImportRef),
  output: Type.Object({ deletedService: Type.Boolean() }),
  permission: importPermission,
  mcp: false,
  audit: true,
});
