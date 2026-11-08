// The settings sections, in the order of the design (Notifications and
// Appearance boards), plus Updates next to General and the signed-in
// person's own Security page in a group of its own.

import type { MessageKey } from "../i18n/t";

export interface SettingsNavItem {
  to: string;
  label: MessageKey;
}

export const settingsNav = [
  { to: "/settings/general", label: "settings.sections.general" },
  { to: "/settings/updates", label: "settings.sections.updates" },
  { to: "/settings/people", label: "settings.sections.people" },
  { to: "/settings/api-keys", label: "settings.sections.apiKeys" },
  { to: "/settings/github", label: "settings.sections.github" },
  { to: "/settings/git-providers", label: "settings.sections.gitProviders" },
  { to: "/settings/cloudflare", label: "settings.sections.cloudflare" },
  { to: "/settings/tailscale", label: "settingsTailscale.nav" },
  { to: "/settings/notifications", label: "settings.sections.notifications" },
  { to: "/settings/backups", label: "settings.sections.backups" },
  { to: "/settings/cleanup", label: "settings.sections.cleanup" },
  { to: "/settings/maintenance", label: "settings.sections.maintenance" },
  { to: "/settings/appearance", label: "settings.sections.appearance" },
  { to: "/settings/ai", label: "settings.sections.ai" },
  { to: "/settings/telemetry", label: "settings.sections.telemetry" },
] as const satisfies readonly SettingsNavItem[];

/** Settings about the signed-in person rather than the panel. */
export const accountNav = [{ to: "/settings/security", label: "settings.sections.security" }] as const satisfies readonly SettingsNavItem[];
