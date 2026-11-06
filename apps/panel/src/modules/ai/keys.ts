// Settings key of the AI assistant, declared by augmenting SettingValues.

import type { ai as aiOps } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";

export interface StoredAiSettings {
  enabled: boolean;
  /** Anthropic API key sealed with purpose "ai.anthropic-key"; null when none is stored. */
  keySealed: string | null;
  keyHint: string;
  routing: aiOps.AiSettings["routing"];
  monthlyBudgetUsd: number | null;
  allowMembers: boolean;
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
};

export function readAiSettings(db: PanelDb): StoredAiSettings {
  return { ...defaultAiSettings, ...getSetting(db, "ai") };
}
