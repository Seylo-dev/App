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
