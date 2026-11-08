// The maintenance and down page: a service's own HTML, else the global
// page, else the built-in one with the message filled in. The node's edge
// serves the result as is, with a CSP that blocks scripts and frames
// (go/internal/proxy PageContentSecurityPolicy, set in edge/server.go).

import { displayName } from "@seylo/brand";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { maintenancePages } from "../../db/schema";
import { getSetting } from "../../settings";
import "./settings";

export const defaultMessage = "We are doing some maintenance. Please check back in a few minutes.";

export interface GlobalMaintenanceState {
  enabled: boolean;
  message: string;
  html: string | null;
  updatedAt: Date | null;
}

export function globalMaintenanceState(db: PanelDb): GlobalMaintenanceState {
  const value = getSetting(db, "maintenanceGlobal");
  return {
    enabled: value?.enabled ?? false,
    message: value?.message ?? "",
    html: value?.html ?? null,
    updatedAt: value ? new Date(value.updatedAt) : null,
  };
}

export function servicePageRow(db: PanelDb, serviceId: string) {
  return db.select().from(maintenancePages).where(eq(maintenancePages.serviceId, serviceId)).get();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The built-in page: plain, light, readable without CSS from elsewhere. */
export function builtInPage(message: string): string {
  const text = escapeHtml(message.trim() || defaultMessage);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Back soon</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f7fd; color: #0f172a; }
  main { max-width: 32rem; margin: 24px; padding: 40px 36px; background: #fff; border-radius: 12px;
    box-shadow: 0 1px 2px rgb(15 23 42 / 0.06), 0 12px 32px rgb(37 99 235 / 0.08); }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
  p { margin: 0; color: #475569; }
  footer { margin-top: 24px; font-size: 12px; color: #94a3b8; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b1220; color: #e2e8f0; }
    main { background: #111a2e; box-shadow: none; }
    p { color: #94a3b8; }
  }
</style>
</head>
<body>
<main>
<h1>Back soon</h1>
<p>${text}</p>
<footer>Served by ${escapeHtml(displayName)}</footer>
</main>
</body>
</html>
`;
}

export type PageSource = "service" | "global" | "default";

/** Which page visitors of a service get, already rendered. */
export function effectivePage(db: PanelDb, serviceId: string | null): { html: string; source: PageSource } {
  const global = globalMaintenanceState(db);
  const own = serviceId ? servicePageRow(db, serviceId) : undefined;
  if (own?.html) return { html: own.html, source: "service" };
  if (global.html) return { html: global.html, source: "global" };
  return { html: builtInPage(own?.message || global.message), source: "default" };
}
