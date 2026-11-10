// Settings key of the AI assistant, declared by augmenting SettingValues,
// and the per-person auto mode, which lives on the users row.

import type { ai as aiOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { users } from "../../db/schema";
import { getSetting } from "../../settings";

export interface StoredAiSettings {
  enabled: boolean;
  /** Anthropic API key sealed with purpose "ai.anthropic-key"; null when none is stored. */
  keySealed: string | null;
  keyHint: string;
  routing: aiOps.AiSettings["routing"];
  monthlyBudgetUsd: number | null;
  allowMembers: boolean;
  /** The Assistant page in the sidebar; on unless an owner or admin turned it off. */
  chatPage: boolean;
}

declare module "../../settings" {
  interface SettingValues {
    ai: StoredAiSettings;
  }
}

export const defaultAiSettings: StoredAiSettings = {
  enabled: false,
  keySealed: null,
  keyHint: "",
  routing: { mode: "auto", model: "sonnet", allowOpus: false },
  monthlyBudgetUsd: 20,
  allowMembers: false,
  chatPage: true,
};

export function readAiSettings(db: PanelDb): StoredAiSettings {
  return { ...defaultAiSettings, ...getSetting(db, "ai") };
}

/** A person's auto mode (users.ai_auto_mode); false for someone who no longer exists. */
export function readAutoMode(db: PanelDb, userId: string): boolean {
  return db.select({ on: users.aiAutoMode }).from(users).where(eq(users.id, userId)).get()?.on ?? false;
}
