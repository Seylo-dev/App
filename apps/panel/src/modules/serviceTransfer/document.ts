// Checks on what an import brings, in the spirit of the agent's manifest
// check for panel moves: the browser already read the zip, but nothing it
// sends is trusted. Errors name the path and the rule, never the value
// (a value may be a secret).

import { OpError, serviceTransfer as transferOps } from "@seylo/ops";
import { cleanName } from "@seylo/zip/read";
import { Kind, type TObject, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

type Manifest = transferOps.PortableManifestV1;
type Doc = transferOps.PortableServiceV1;

const limits = transferOps.transferLimits;

function bad(reason: string, message: string, field?: string): OpError {
  return new OpError("BAD_REQUEST", message, { reason, ...(field ? { field } : {}) });
}

/** The first schema error as "path: rule". */
function firstError(schema: TSchema, value: unknown): { path: string; message: string } {
  const error = [...Value.Errors(schema, value)][0];
  return { path: error?.path || "/", message: error?.message ?? "does not fit the format" };
}

/** manifest.json: format, version, features, and every entry's name, size and hash. */
export function checkManifest(text: string): Manifest {
  if (Buffer.byteLength(text) > limits.manifestBytes) throw bad("tooLarge", "manifest.json is larger than an export's manifest can be.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad("badManifest", "manifest.json is not JSON.");
  }
  const head = (raw ?? {}) as { format?: unknown; formatVersion?: unknown; panel?: { version?: unknown } };
  if (head.format !== transferOps.exportFormat) throw bad("notExport", "This is not a service export file.");
  if (typeof head.formatVersion === "number" && head.formatVersion > transferOps.exportFormatVersion) {
    const version = typeof head.panel?.version === "string" ? ` (${head.panel.version.slice(0, 40)})` : "";
    throw bad("newerFormat", `This file comes from a newer panel${version}. Update this panel first.`);
  }
  if (!Value.Check(transferOps.PortableManifestV1, raw)) {
    const e = firstError(transferOps.PortableManifestV1, raw);
    throw bad("badManifest", `manifest.json ${e.path}: ${e.message}.`);
  }
  const manifest = raw as Manifest;
  const unknown = manifest.requires.filter((f) => !transferOps.knownFeatures.includes(f));
  if (unknown.length > 0)
    throw bad("requires", `This file needs ${unknown.join(", ")}, which this panel does not read. Update this panel first.`);

  const services = new Map(manifest.services.map((s) => [s.name, s]));
  if (services.size !== manifest.services.length) throw bad("badManifest", "manifest.json lists a service twice.");
  for (const s of manifest.services)
    if (s.path !== `services/${s.name}/`) throw bad("badManifest", `manifest.json: ${s.name} has a path that is not services/${s.name}/.`);
  const seen = new Set<string>();
  const volumes = new Map<string, number>();
  for (const [i, entry] of manifest.entries.entries()) {
    const at = `manifest.json /entries/${i}`;
    // A clean relative path (no "/" in front, no "\", no NUL, no "." or ".."), one of the allowed names.
    if (!cleanName(entry.path) || entry.path.normalize("NFC") !== entry.path)
      throw bad("badPath", `${at}: the path is not a clean relative path.`);
    if (!transferOps.isExportEntryName(entry.path))
      throw bad("badPath", `${at}: ${JSON.stringify(entry.path.slice(0, 80))} is not a name an export has.`);
    if (entry.path === transferOps.entryPatterns.manifest || entry.path === transferOps.entryPatterns.signature)
      throw bad("badPath", `${at}: the manifest cannot list itself or its signature.`);
    if (seen.has(entry.path)) throw bad("duplicate", `${at}: ${entry.path} is listed twice.`);
    seen.add(entry.path);
    const owner =
      transferOps.entryPatterns.service.exec(entry.path)?.[1] ??
      transferOps.entryPatterns.upload.exec(entry.path)?.[1] ??
      transferOps.entryPatterns.volume.exec(entry.path)?.[1];
    if (owner !== undefined && !services.has(owner)) throw bad("badPath", `${at}: ${entry.path} belongs to no service of the file.`);
    if (transferOps.entryPatterns.volume.test(entry.path) && owner) {
      volumes.set(owner, (volumes.get(owner) ?? 0) + 1);
      if ((volumes.get(owner) ?? 0) > limits.volumesPerService)
        throw bad("badManifest", `${at}: more than ${limits.volumesPerService} volumes for ${owner}.`);
    }
    if (transferOps.entryPatterns.upload.test(entry.path) && entry.size > limits.uploadBytes)
      throw bad("tooLarge", `${at}: the archive is larger than ${limits.uploadBytes / 1024 / 1024} MB.`);
  }
  const encrypted = manifest.secrets === "encrypted";
  if (encrypted !== seen.has(transferOps.entryPatterns.secrets)) {
    throw bad(
      "badManifest",
      encrypted
        ? "The file says it is encrypted but lists no secrets.enc."
        : "The file lists secrets.enc but says its secrets were left out.",
    );
  }
  for (const s of manifest.services) {
    const listed = seen.has(`services/${s.name}/service.json`);
    if (encrypted && listed) throw bad("badManifest", `An encrypted file keeps ${s.name}'s settings in secrets.enc, not in service.json.`);
    if (!encrypted && !listed) throw bad("badManifest", `The file lists no service.json for ${s.name}.`);
  }
  return manifest;
}

/** The manifest entry for `path`, or BAD_REQUEST. */
export function manifestEntry(manifest: Manifest, path: string) {
  const entry = manifest.entries.find((e) => e.path === path);
  if (!entry) throw bad("badManifest", `manifest.json does not list ${path}.`);
  return entry;
}

/**
 * Keys of `value` that `schema` does not describe, by path: settings a
 * newer panel wrote. Unions follow the variant the value fits.
 */
export function unknownPaths(schema: TSchema, value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  const kind = schema[Kind];
  if (kind === "Union") {
    const variant = (schema.anyOf as TSchema[]).find((s) => Value.Check(s, value));
    return variant ? unknownPaths(variant, value, path) : [];
  }
  if (kind === "Array" && Array.isArray(value)) {
    return value.flatMap((item, i) => unknownPaths(schema.items as TSchema, item, `${path}/${i}`));
  }
  if (kind === "Record") {
    const [inner] = Object.values((schema.patternProperties ?? {}) as Record<string, TSchema>);
    return inner ? Object.entries(value).flatMap(([k, v]) => unknownPaths(inner, v, `${path}/${k}`)) : [];
  }
  if (kind === "Object") {
    const props = (schema as TObject).properties;
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      k in props ? unknownPaths(props[k] as TSchema, v, `${path}/${k}`) : [`${path}/${k}`],
    );
  }
  return [];
}

/** Lists in the document where one bad item is skipped instead of failing the whole file. */
const itemLists = ["domains", "exposures", "cronJobs", "uptimeChecks", "alerts", "backups"] as const;
const itemNames: Record<(typeof itemLists)[number], string> = {
  domains: "Domain",
  exposures: "Database listener",
  cronJobs: "Cron job",
  uptimeChecks: "Uptime check",
  alerts: "Alert rule",
  backups: "Backup schedule",
};
/** A short name for a skipped item: its host, name, event or port. */
function itemLabel(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, unknown>;
  for (const key of ["host", "name", "event", "listenPort"] as const) {
    const v = o[key];
    if (typeof v === "string" || typeof v === "number") return String(v).slice(0, 80);
  }
  return "";
}

/** Optional sections that are left out when they do not fit (access, tunnel, maintenance). */
const optionalSections = ["access", "tunnel", "maintenance"] as const;

export interface CheckedDocument {
  doc: Doc;
  /** Settings this panel does not know, skipped. */
  unknownSettings: string[];
  /** Items and sections that did not fit the format, left out. */
  skipped: { what: string; why: string }[];
}

/**
 * service.json (or the document inside secrets.enc) against the format.
 * An item of a list that does not fit (an unknown domain middleware, a new
 * alert event) is left out with a note, never imported weaker; anything
 * else that does not fit refuses the file with the path.
 */
export function checkDocument(raw: unknown, service: Manifest["services"][number]): CheckedDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("badDocument", "service.json is not an object.");
  const doc = structuredClone(raw) as Record<string, unknown>;
  const skipped: CheckedDocument["skipped"] = [];
  for (let round = 0; round < 1000 && !Value.Check(transferOps.PortableServiceV1, doc); round++) {
    const e = firstError(transferOps.PortableServiceV1, doc);
    const [, section, index] = e.path.split("/");
    const list = itemLists.find((l) => l === section);
    if (list && index !== undefined && /^\d+$/.test(index) && Array.isArray(doc[list])) {
      const [item] = (doc[list] as unknown[]).splice(Number(index), 1);
      skipped.push({
        what: `${itemNames[list]} ${itemLabel(item)}`.trim(),
        why: `It has settings this panel does not read (${e.path}: ${e.message}).`,
      });
      continue;
    }
    const optional = optionalSections.find((s) => s === section);
    if (optional && doc[optional] !== null) {
      doc[optional] = null;
      skipped.push({
        what: optional === "access" ? "IP:port access settings" : optional === "tunnel" ? "The Cloudflare tunnel" : "The maintenance page",
        why: `It has settings this panel does not read (${e.path}: ${e.message}).`,
      });
      continue;
    }
    throw bad("badDocument", `service.json ${e.path}: ${e.message}.`, e.path);
  }
  if (!Value.Check(transferOps.PortableServiceV1, doc)) throw bad("badDocument", "service.json does not fit the format.");
  const checked = doc as unknown as Doc;
  if (checked.name !== service.name || checked.kind !== service.kind)
    throw bad("badDocument", "service.json names another service than manifest.json.");
  if (checked.kind === "compose") {
    throw new OpError("CONFLICT", "Compose stacks cannot be imported yet.", { reason: "compose" });
  }
  return { doc: checked, unknownSettings: unknownPaths(transferOps.PortableServiceV1, raw), skipped };
}
