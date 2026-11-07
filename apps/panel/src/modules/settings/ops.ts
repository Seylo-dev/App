// Handlers of the settings ops: general (name, domain, default node),
// branding (name, sign-in message, logos and favicon on disk), appearance
// (theme preset, color mode, accent, owner-only custom CSS) and the
// telemetry opt-in.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpError, settings } from "@seylo/ops";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { readAuditRetentionDays, writeAuditRetentionDays } from "../audit/retention";
import { assertHostUnclaimed } from "../domains/ownership";
import { syncWebhookConfig } from "../github/app";
import { readTelemetry, syncTelemetrySchedule } from "../telemetry";
import { domainCheckJobType, nodeExists, readDomainStatus } from "./domain";
import { brandingDir } from "./http";
import { brandAssetUrl, readAppearance, readBranding, readPanelName } from "./keys";
import { panelPublicUrl } from "./public-url";
import "../uptime/targets";

/** Ops whose results change with the boot data; the web app refetches them after a save. */
const bootOps = ["settings.boot", "settings.branding", "settings.appearance", "settings.general", "system.info"];

function general(deps: Pick<Deps, "db" | "config">) {
  return {
    name: readPanelName(deps.db),
    domain: getSetting(deps.db, "panelDomain") ?? null,
    domainStatus: readDomainStatus(deps),
    defaultNodeId: getSetting(deps.db, "defaultNodeId") ?? null,
    publicUrl: panelPublicUrl(deps),
    uptimeAllowInternalTargets: getSetting(deps.db, "uptimeAllowInternalTargets") === true,
    auditRetentionDays: readAuditRetentionDays(deps.db),
  };
}

function branding(deps: Pick<Deps, "db">) {
  const stored = readBranding(deps.db);
  return {
    name: readPanelName(deps.db),
    logoLight: brandAssetUrl("logoLight", stored.assets.logoLight),
    logoDark: brandAssetUrl("logoDark", stored.assets.logoDark),
    favicon: brandAssetUrl("favicon", stored.assets.favicon),
    loginMessage: stored.loginMessage,
    hidePoweredBy: stored.hidePoweredBy,
  };
}

function telemetryView(deps: Pick<Deps, "db">) {
  const stored = readTelemetry(deps);
  return {
    enabled: stored.enabled,
    installId: stored.installId,
    lastSentAt: stored.lastSentAt ? new Date(stored.lastSentAt).toISOString() : null,
  };
}

const bootChanged = (ctx: OpContext) => ctx.live.publish("panel", { type: "invalidate", ops: bootOps });

export const generalOp = implement(settings.general, (_input, ctx) => general(ctx));

export const updateGeneral = implement(settings.updateGeneral, (input, ctx) => {
  if (input.defaultNodeId && !nodeExists(ctx, input.defaultNodeId)) {
    throw new OpError("BAD_REQUEST", "There is no such node.", { field: "defaultNodeId" });
  }
  if (input.name !== undefined) setSetting(ctx.db, "panelName", input.name);
  if (input.defaultNodeId !== undefined) setSetting(ctx.db, "defaultNodeId", input.defaultNodeId);
  if (input.uptimeAllowInternalTargets !== undefined) setSetting(ctx.db, "uptimeAllowInternalTargets", input.uptimeAllowInternalTargets);
  if (input.auditRetentionDays !== undefined) {
    // A shorter retention deletes history: not something a model may do on its own.
    const fromModel = (ctx.transport ?? "http") !== "http" || (ctx.principal.type === "apiKey" && ctx.principal.keyKind === "mcp");
    if (fromModel)
      throw new OpError("FORBIDDEN", "Change how long the activity log keeps entries in the panel, not through MCP or the assistant.");
    writeAuditRetentionDays(ctx.db, input.auditRetentionDays);
  }
  if (input.domain !== undefined && input.domain !== (getSetting(ctx.db, "panelDomain") ?? null)) {
    // A service routing the same host would share (and fight over) the panel's route.
    if (input.domain) assertHostUnclaimed(ctx.db, input.domain, { field: "domain", panel: true });
    setSetting(ctx.db, "panelDomain", input.domain);
    // The old domain's status must not count for anything (redirects, agent moves) any more.
    deleteSetting(ctx.db, "panelDomainStatus");
    // The panel's own route lives on its node; agents also learn the new URL from the desired state.
    ctx.agents.desired.markDirty({ all: true });
    // GitHub's webhook follows the domain (best effort; polling covers a failure).
    void syncWebhookConfig(ctx);
  }
  // Saving the domain again (changed or not) checks it now instead of at the next 5-minute run.
  if (input.domain) ctx.jobs.enqueue(domainCheckJobType, {}, { dedupeKey: "settings.checkDomain.now" });
  bootChanged(ctx);
  ctx.live.publish("panel", { type: "invalidate", ops: ["system.features", "mcp.info"] });
  return general(ctx);
});

export const brandingOp = implement(settings.branding, (_input, ctx) => branding(ctx));

export const updateBranding = implement(settings.updateBranding, (input, ctx) => {
  if (input.name !== undefined) setSetting(ctx.db, "panelName", input.name);
  const stored = readBranding(ctx.db);
  setSetting(ctx.db, "branding", {
    ...stored,
    ...(input.loginMessage !== undefined ? { loginMessage: input.loginMessage } : {}),
    ...(input.hidePoweredBy !== undefined ? { hidePoweredBy: input.hidePoweredBy } : {}),
  });
  bootChanged(ctx);
  return branding(ctx);
});

/** The first bytes of each allowed type, so a renamed file cannot pose as an image. */
function looksLike(contentType: string, bytes: Buffer): boolean {
  const head = bytes.subarray(0, 16);
  switch (contentType) {
    case "image/png":
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8;
    case "image/webp":
      return head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0;
    case "image/svg+xml": {
      const text = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
      return text.startsWith("<svg") || text.startsWith("<?xml");
    }
    default:
      return false;
  }
}

export const uploadBrandAsset = implement(settings.uploadBrandAsset, (input, ctx) => {
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/.exec(input.dataUrl);
  if (!match) throw new OpError("BAD_REQUEST", "The file must be a base64 data URL.", { field: "dataUrl" });
  const contentType = match[1] as string;
  const bytes = Buffer.from(match[2] as string, "base64");
  if (bytes.length === 0) throw new OpError("BAD_REQUEST", "The file is empty.", { field: "dataUrl" });
  if (bytes.length > settings.brandAssetMaxBytes) {
    throw new OpError("BAD_REQUEST", "The file is larger than 512 KiB.", { field: "dataUrl" });
  }
  if (!looksLike(contentType, bytes)) {
    throw new OpError("BAD_REQUEST", `The file is not a ${contentType.replace("image/", "").toUpperCase()} image.`, { field: "dataUrl" });
  }
  const dir = brandingDir(ctx.config.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, input.kind);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  renameSync(temp, target);
  const stored = readBranding(ctx.db);
  setSetting(ctx.db, "branding", {
    ...stored,
    assets: { ...stored.assets, [input.kind]: { hash: createHash("sha256").update(bytes).digest("hex"), contentType } },
  });
  bootChanged(ctx);
  return branding(ctx);
});

export const removeBrandAsset = implement(settings.removeBrandAsset, (input, ctx) => {
  const stored = readBranding(ctx.db);
  const { [input.kind]: _removed, ...assets } = stored.assets;
  setSetting(ctx.db, "branding", { ...stored, assets });
  rmSync(join(brandingDir(ctx.config.dataDir), input.kind), { force: true });
  bootChanged(ctx);
  return branding(ctx);
});

export const appearanceOp = implement(settings.appearance, (_input, ctx) => readAppearance(ctx.db));

export const updateAppearance = implement(settings.updateAppearance, (input, ctx) => {
  const current = readAppearance(ctx.db);
  if (input.customCss !== undefined && input.customCss !== current.customCss) {
    const role = ctx.principal.type === "anonymous" ? null : ctx.principal.user.role;
    if (role !== "owner") throw new OpError("FORBIDDEN", "Only the owner can change the custom CSS.", { field: "customCss" });
  }
  const next = {
    preset: input.preset ?? current.preset,
    colorMode: input.colorMode ?? current.colorMode,
    accent: input.accent !== undefined ? input.accent : current.accent,
    customCss: input.customCss ?? current.customCss,
  };
  setSetting(ctx.db, "appearance", next);
  bootChanged(ctx);
  return next;
});

export const telemetryOp = implement(settings.telemetry, (_input, ctx) => telemetryView(ctx));

export const updateTelemetry = implement(settings.updateTelemetry, (input, ctx) => {
  const current = readTelemetry(ctx);
  setSetting(ctx.db, "telemetry", { ...current, enabled: input.enabled });
  syncTelemetrySchedule(ctx);
  ctx.live.publish("panel", { type: "invalidate", ops: ["settings.telemetry", "telemetry.preview", "system.features"] });
  return telemetryView(ctx);
});
