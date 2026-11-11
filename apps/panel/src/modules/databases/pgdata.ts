// Where a PostgreSQL database's data is (0.2.11, any image of the engine).
// Postgres 18 and later images keep each major's cluster in a folder of
// its own (/var/lib/postgresql/18/docker) under a volume at
// /var/lib/postgresql; older images look in /var/lib/postgresql/data and
// declare it a VOLUME, so on a volume at /var/lib/postgresql Docker gives
// that folder an anonymous volume of its own. On real Docker
// (TestITPostgresOtherMajorKeepsData):
//
//   - an 18 database set to 17 starts healthy on an empty database in that
//     anonymous volume, which goes with the container: whatever is written
//     there is lost on the next deploy, and the old container never comes
//     back since the new one got healthy;
//   - a database made from an image older than 18 whose tag names no
//     release (a digest, an old named tag) keeps its data in that anonymous
//     volume too, gone on the next deploy.
//
// PGDATA in the database's own variables fixes both: databases.setVersion
// pins it to the folder of the cluster that runs before a move to another
// line (a version that cannot read those data files then fails, and the
// old container comes back), and databases.create sets it for an image
// whose tag names no release. A volume at /var/lib/postgresql/data needs
// neither: an older image looks there and refuses another major's data,
// and Postgres 18 refuses a volume at that old folder.

import { parseEnv } from "@seylo/env-analyzer";
import type { DatabaseEngine } from "../../db/schema";
import { customLine } from "./images";

/** Where the volume of a Postgres 18 (or later) database is mounted. */
export const postgresVolumeRoot = "/var/lib/postgresql";

/** PGDATA of a database made from an image whose tag names no release: a folder of the volume no image declares. */
export const customDataFolder = "/var/lib/postgresql/docker";

/** The folder an image of a Postgres line from 18 on keeps its cluster in; null for an older line or one that names no release. */
export function lineDataFolder(line: string): string | null {
  if (!/^\d+$/.test(line) || Number(line) < 18) return null;
  return `${postgresVolumeRoot}/${line}/docker`;
}

/** Whether the database's own .env sets PGDATA (then every image of it runs on that folder). */
export function definesPgdata(envText: string): boolean {
  return parseEnv(envText).entries.some((e) => e.key === "PGDATA");
}

/**
 * Whether a change of a Postgres database needs PGDATA pinned first: its
 * volume is at /var/lib/postgresql, its .env sets none, and it moves to
 * another line or from or to an image whose tag names no release (the
 * same line keeps the same folder).
 */
export function needsPgdataPin(engine: DatabaseEngine, mountPath: string, envText: string, from: string, to: string): boolean {
  if (engine !== "postgres" || mountPath !== postgresVolumeRoot || definesPgdata(envText)) return false;
  return from !== to || from === customLine;
}

/** The .env with PGDATA set to folder, a comment saying why; the text is kept as it is above it. */
export function withPgdata(envText: string, folder: string, why: string): string {
  const head = envText.length === 0 || envText.endsWith("\n") ? envText : `${envText}\n`;
  return `${head}${head.trim() ? "\n" : ""}# ${why}\nPGDATA=${folder}\n`;
}

/** The comment of a pin databases.setVersion writes. */
export const versionPinNote =
  "Set by a version change: PostgreSQL runs on the folder of the data that ran, so a version that cannot read it fails instead of starting an empty database.";

/** The comment of the pin databases.create writes. */
export const createPinNote =
  "Set by Seylo: the image's tag names no release, so PostgreSQL keeps its data in this folder of the data volume, whatever release it is.";

/**
 * The .env databases.create gives a PostgreSQL database made from an image
 * whose tag names no release (latest, a digest, an old named tag): PGDATA
 * on a folder of its volume, whatever release the image is. Null for every
 * other database, which starts with no variables of its own.
 */
export function createdPgdata(engine: DatabaseEngine, version: { version: string; dataPath: string }): string | null {
  if (engine !== "postgres" || version.version !== customLine || version.dataPath !== postgresVolumeRoot) return null;
  return withPgdata("", customDataFolder, createPinNote);
}

/** The exec call that prints a running Postgres container's PGDATA (where the cluster that runs is). */
export const pgdataExec = { command: ["sh", "-c", 'printf "%s\\n" "$PGDATA"'], stdin: "" };
