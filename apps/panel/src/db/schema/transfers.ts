// Service exports and imports (modules/serviceTransfer). An export row
// holds what its download link writes, sealed, only until the download
// started; an import row holds the opened file, sealed, until the service
// was created from it. Neither keeps a passphrase.

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, json, sealed, timestamp, updatedAt } from "./columns";
import { users } from "./identity";
import { projects, services } from "./projects";

/** ready: the link may be used (2 minutes); streaming: its download runs. */
export type ServiceExportStatus = "ready" | "streaming" | "done" | "failed" | "cancelled";

/** One entry of an export or import: its path in the zip, size and sha256 (uncompressed). */
export interface TransferEntry {
  path: string;
  size: number;
  sha256: string;
}

export const serviceExports = sqliteTable(
  "service_exports",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    status: text("status").$type<ServiceExportStatus>().notNull().default("ready"),
    secrets: text("secrets").$type<"encrypted" | "omitted">().notNull(),
    /**
     * Sealed "service.export": JSON of the small entries the download writes
     * (README, service.json or secrets.enc), the manifest's fields and the
     * MAC key when encrypted. Wiped when the download starts or the link
     * expires.
     */
    payloadSealed: sealed("payload_sealed"),
    /** source_uploads.id of the archive the file carries; null when none. */
    uploadId: text("upload_id"),
    /** Volumes whose data goes in the file, read from node_id. */
    volumes: json<string[]>("volumes").notNull().default([]),
    /** The node the volumes are read from; no foreign key, so removing a node never waits for old rows. */
    nodeId: text("node_id"),
    /** Stop the service while its volumes are read (always for databases). */
    stopService: integer("stop_service", { mode: "boolean" }).notNull().default(false),
    /** The download stopped the service and has to start it again when it ends (also after a panel restart). */
    sourceStopped: integer("source_stopped", { mode: "boolean" }).notNull().default(false),
    fileName: text("file_name").notNull(),
    bytesSent: integer("bytes_sent").notNull().default(0),
    /** sha256 of the whole .zip as it went out. */
    zipSha256: text("zip_sha256"),
    /** What the manifest listed. */
    entries: json<TransferEntry[]>("entries"),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("service_exports_service_idx").on(t.serviceId), index("service_exports_status_idx").on(t.status)],
);

/** previewing: opened, nothing created; receiving: created, entries still to upload. */
export type ServiceImportStatus = "previewing" | "receiving" | "done" | "failed";

export interface ImportEntry extends TransferEntry {
  /** upload: the uploaded archive (missing on rows from before volumes); volume: a volume's data. */
  kind?: "upload" | "volume";
  status: "pending" | "done" | "failed";
  /** Bytes received so far (parts go up in order). */
  received: number;
  /** The archive's name for the Source tab ("" for volumes). */
  fileName: string;
  /** Volumes: its name, and the limits the agent unpacks it with. */
  volume?: string;
  maxBytes?: number;
  maxEntries?: number;
  error: string | null;
}

export const serviceImports = sqliteTable(
  "service_imports",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => services.id, { onDelete: "set null" }),
    status: text("status").$type<ServiceImportStatus>().notNull().default("previewing"),
    /**
     * Sealed "service.import": JSON of the manifest, the service document and
     * the secret values from the file. Null once the service was created.
     */
    docSealed: sealed("doc_sealed"),
    manifestSha256: text("manifest_sha256").notNull(),
    /** serviceTransfer.setChoices; never a password. */
    choices: json<Record<string, unknown>>("choices").notNull(),
    /** Entries still to upload after the service was created (an upload app's archive). */
    entries: json<ImportEntry[]>("entries").notNull(),
    panelVersion: text("panel_version").notNull(),
    secrets: text("secrets").$type<"encrypted" | "omitted">().notNull(),
    /** The manifest's panel id is this panel's. */
    samePanel: integer("same_panel", { mode: "boolean" }).notNull().default(false),
    deployWhenReady: integer("deploy_when_ready", { mode: "boolean" }).notNull().default(false),
    /** The first deploy builds this commit (choices.commit "live"). */
    commitSha: text("commit_sha"),
    error: text("error"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** previewing rows go 24 h after begin; receiving rows 48 h after their last progress. */
    expiresAt: timestamp("expires_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("service_imports_project_idx").on(t.projectId),
    index("service_imports_service_idx").on(t.serviceId),
    index("service_imports_expires_idx").on(t.expiresAt),
  ],
);
