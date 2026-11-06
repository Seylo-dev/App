// Sealed .env text at rest: a service's own file (service_env) and the
// project's shared variables (project_env). Values are only ever opened
// in memory, for the editor, the References list and the desired state.

import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { projectEnv, serviceEnv } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";

export interface StoredEnv {
  text: string;
  updatedAt: Date | null;
}

export function readServiceEnv(db: PanelDb, secrets: SecretBox, serviceId: string): StoredEnv {
  const row = db.select().from(serviceEnv).where(eq(serviceEnv.serviceId, serviceId)).get();
  if (!row) return { text: "", updatedAt: null };
  return { text: secrets.open(row.contentSealed, "service.env") ?? "", updatedAt: row.updatedAt };
}

export function writeServiceEnv(db: PanelDb, secrets: SecretBox, serviceId: string, text: string, userId: string | null): Date {
  const contentSealed = secrets.seal(text, "service.env");
  const updatedAt = new Date();
  db.insert(serviceEnv)
    .values({ serviceId, contentSealed, updatedBy: userId, updatedAt })
    .onConflictDoUpdate({ target: serviceEnv.serviceId, set: { contentSealed, updatedBy: userId, updatedAt } })
    .run();
  return updatedAt;
}

export function readProjectEnv(db: PanelDb, secrets: SecretBox, projectId: string): StoredEnv {
  const row = db.select().from(projectEnv).where(eq(projectEnv.projectId, projectId)).get();
  if (!row) return { text: "", updatedAt: null };
  return { text: secrets.open(row.contentSealed, "project.env") ?? "", updatedAt: row.updatedAt };
}

export function writeProjectEnv(db: PanelDb, secrets: SecretBox, projectId: string, text: string, userId: string | null): Date {
  const contentSealed = secrets.seal(text, "project.env");
  const updatedAt = new Date();
  db.insert(projectEnv)
    .values({ projectId, contentSealed, updatedBy: userId, updatedAt })
    .onConflictDoUpdate({ target: projectEnv.projectId, set: { contentSealed, updatedBy: userId, updatedAt } })
    .run();
  return updatedAt;
}

/** Optimistic concurrency: the caller's updatedAt must match what is stored (null = never saved). */
export function matchesExpected(stored: Date | null, expected: string | null | undefined): boolean {
  if (expected === undefined) return true;
  if (expected === null) return stored === null;
  return stored !== null && stored.getTime() === new Date(expected).getTime();
}
