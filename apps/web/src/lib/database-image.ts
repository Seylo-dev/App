// Any image of a database engine (0.2.11): what the web needs to know about
// one before the panel judges it. The New database form says when a tag
// floats (latest, "8.2": the release behind it can change on the next
// deploy), and the Version card reads databases.setVersion's
// riskNotAccepted refusal (what can go wrong, and whether a backup is
// needed) to show it in plain words and send acceptRisk once accepted.
// The panel's images.ts and version.ts decide; these only describe.

import { OpError } from "@seylo/ops";

/** The tag of an image reference, null for a digest or none (then it is latest). */
function tagOf(image: string): string | null {
  const name = image.trim();
  if (name.includes("@")) return null;
  const colon = name.lastIndexOf(":");
  return colon < 0 || name.indexOf("/", colon) >= 0 ? "latest" : name.slice(colon + 1);
}

/**
 * Whether an image's tag floats: it names no exact release (Postgres
 * 17.6, ClickHouse 26.8.36.3, pgvector 0.8.7-pg17, KeyDB x86_64_v6.3.4, the
 * others 8.2.12) and no digest pins it.
 */
export function isFloatingImage(engine: string, image: string, variant: string | null = null): boolean {
  const tag = tagOf(image);
  if (tag === null) return false;
  if (variant === "pgvector") return !/^\d+\.\d+\.\d+-pg\d+(-|$)/.test(tag);
  const release = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? /_v?(\d+(?:\.\d+)+)/.exec(tag)?.[1];
  if (!release) return true;
  const parts = release.split(".").length;
  const major = Number(release.split(".")[0]);
  const exact = engine === "postgres" ? (major >= 10 ? 2 : 3) : engine === "clickhouse" ? 4 : 3;
  return parts < exact;
}

/** The version recorded for an image whose tag names no release (latest, a digest). */
const customLine = "custom";

/**
 * The line databases.setVersion would record for an image (the panel's
 * images.ts engineImage): the catalog line of that very image, pgvector's
 * "-pg17", else the release in its tag as a line (Postgres its major from
 * 10 on, the others major.minor), else "custom". The Version card's notes
 * (the backup, MySQL 8.4's mysql_native_password logins) follow it until
 * the panel answers with its own.
 */
export function imageLine(
  engine: string,
  image: string,
  catalog: readonly { version: string; image: string }[],
  variant: string | null = null,
): string {
  const name = image
    .trim()
    .replace(/^docker\.io\//, "")
    .replace(/^library\//, "");
  const ref = name.includes("@") || /:[^/]*$/.test(name) ? name : `${name}:latest`;
  const exact = catalog.find((v) => v.image === ref);
  if (exact) return exact.version;
  // The tag in front of a digest still names the release ("mongo:8.0.40@sha256:...").
  const named = ref.replace(/@.*$/, "");
  const colon = named.lastIndexOf(":");
  if (colon < 0 || named.indexOf("/", colon) >= 0) return customLine;
  const tag = named.slice(colon + 1);
  if (variant === "pgvector") return /(?:^|-)pg(\d+)(?:-|$)/.exec(tag)?.[1] ?? customLine;
  const release = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? /_v?(\d+(?:\.\d+)+)/.exec(tag)?.[1];
  if (!release) return customLine;
  const [major, minor] = release.split(".");
  if (engine === "postgres" && Number(major) >= 10) return major ?? customLine;
  return minor === undefined ? customLine : `${major}.${minor}`;
}

/** What databases.setVersion's riskNotAccepted refusal says (details), null for any other error. */
export interface RiskRefusal {
  /** The most serious risk. */
  risk: string;
  /** Every risk, the most serious first. */
  risks: string[];
  /** The panel's sentences. */
  message: string;
  /** The line the change would record ("8.2", "custom"). */
  version: string;
  image: string;
  /** A backup from the last 24 hours (or confirmNoBackup) is needed as well. */
  backupRequired: boolean;
}

export function riskRefusalOf(error: unknown): RiskRefusal | null {
  if (!(error instanceof OpError) || error.details?.reason !== "riskNotAccepted") return null;
  const d = error.details;
  const risks = (d.risks ?? "").split(",").filter(Boolean);
  const risk = d.risk || risks[0] || "";
  return {
    risk,
    risks: risks.length ? risks : risk ? [risk] : [],
    message: d.message ?? error.message,
    version: d.version ?? "",
    image: d.image ?? "",
    backupRequired: d.backupRequired === "true",
  };
}
