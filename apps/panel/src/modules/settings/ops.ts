// Handlers of the settings ops: general (name, domain, default node, and
// the domain's "Check now"), branding (name, sign-in message, logos and
// favicon on disk), appearance (theme preset, color mode, accent,
// owner-only custom CSS) and the telemetry opt-in. A domain change also decides IP access again
// (ip-access.ts): the old domain stops counting as a private path at once.
// Removing or changing a domain that nodes connect over needs
// acknowledgeNodesOffline (assertNodesAcknowledged). The panel access ops
// are in panel-access.ts.

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpError, settings } from "@seylo/ops";
import { nodeNames, nodesDialingDomain } from "../../agent-hub/dialed";
import type { Deps } from "../../deps";
import { implement, type OpContext } from "../../ops/implement";
import { deleteSetting, getSetting, setSetting } from "../../settings";
import { readAuditRetentionDays, writeAuditRetentionDays } from "../audit/retention";
import { assertHostUnclaimed } from "../domains/ownership";
import { syncWebhookConfig } from "../github/app";
import { readTelemetry, syncTelemetrySchedule } from "../telemetry";
import { checkDomainNow, domainCheckJobType, nodeExists, readDomainStatus } from "./domain";
import { brandingDir } from "./http";
import { applyPanelIpAccess, readIpAccessApplied, readPanelAccessWanted } from "./ip-access";
import { brandAssetUrl, readAppearance, readBranding, readPanelName } from "./keys";
import { domainPath, privatePathSources } from "./private-paths";
import { panelPublicUrl } from "./public-url";
import "../uptime/targets";

/** Ops whose results change with the boot data; the web app refetches them after a save. */
const bootOps = ["settings.boot", "settings.branding", "settings.appearance", "settings.general", "system.info"];

function general(deps: Pick<Deps, "db" | "config" | "agents">) {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  return {
    name: readPanelName(deps.db),
    domain,
    domainStatus: readDomainStatus(deps),
    defaultNodeId: getSetting(deps.db, "defaultNodeId") ?? null,
    publicUrl: panelPublicUrl(deps),
    uptimeAllowInternalTargets: getSetting(deps.db, "uptimeAllowInternalTargets") === true,
    auditRetentionDays: readAuditRetentionDays(deps.db),
    domainNodes: nodesDialingDomain(deps, domain).map((node) => ({ id: node.id, name: node.name })),
  };
}

/**
 * Removing or changing the domain drops its route at once. Nodes that dial
 * https://<domain> lose the panel: one that joined over the domain has no
 * other address and stays offline until it is joined again; one that moved
 * there from the agents' port comes back over its standing fallback after
 * about 5 minutes. The panel cannot tell them apart, so it asks first.
 */
function assertNodesAcknowledged(ctx: OpContext, input: { domain?: string | null; acknowledgeNodesOffline?: boolean }): void {
  if (input.acknowledgeNodesOffline === true) return;
  const current = getSetting(ctx.db, "panelDomain") ?? null;
  const cutOff = nodesDialingDomain(ctx, current);
  if (cutOff.length === 0) return;
  const one = cutOff.length === 1;
  throw new OpError(
    "CONFLICT",
    `${nodeNames(cutOff)} ${one ? "connects" : "connect"} over https://${current} and ${one ? "goes" : "go"} offline without it. A node that joined over the domain stays offline until it is joined again with a new command from Nodes > Add node (--force); one that moved there from the agents' port comes back over that port in about 5 minutes. Pass acknowledgeNodesOffline: true to ${input.domain ? "change" : "remove"} the domain anyway.`,
    { field: "acknowledgeNodesOffline", reason: "nodesOnDomain", nodeIds: cutOff.map((node) => node.id).join(",") },
  );
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
  const domainChanges = input.domain !== undefined && input.domain !== (getSetting(ctx.db, "panelDomain") ?? null);
  if (domainChanges && keptClosedByDomain(ctx)) {
    throw new OpError(
      "CONFLICT",
      'IP access is closed and set to stay closed, and the panel domain is the only way in that works. Switch "If the domain stops working" to Reopen IP access first.',
      { field: "domain", reason: "stayClosed" },
    );
  }
  if (domainChanges) assertNodesAcknowledged(ctx, input);
  if (input.auditRetentionDays !== undefined) {
    // A shorter retention deletes history: not something a model may do on its own.
    const fromModel = (ctx.transport ?? "http") !== "http" || (ctx.principal.type === "apiKey" && ctx.principal.keyKind === "mcp");
    if (fromModel)
      throw new OpError("FORBIDDEN", "Change how long the activity log keeps entries in the panel, not through MCP or the assistant.");
  }
  // A service routing the same host would share (and fight over) the panel's route.
  if (domainChanges && input.domain) assertHostUnclaimed(ctx.db, input.domain, { field: "domain", panel: true });
  // Every refusal comes before the first write, so a refused save changes nothing.
  if (input.name !== undefined) setSetting(ctx.db, "panelName", input.name);
  if (input.defaultNodeId !== undefined) setSetting(ctx.db, "defaultNodeId", input.defaultNodeId);
  if (input.uptimeAllowInternalTargets !== undefined) setSetting(ctx.db, "uptimeAllowInternalTargets", input.uptimeAllowInternalTargets);
  if (input.auditRetentionDays !== undefined) writeAuditRetentionDays(ctx.db, input.auditRetentionDays);
  if (input.domain !== undefined && domainChanges) {
    setSetting(ctx.db, "panelDomain", input.domain);
    // The old domain's status must not count for anything (redirects, agent moves, IP access) any more.
    deleteSetting(ctx.db, "panelDomainStatus");
    // The panel's own route lives on its node; agents also learn the new URL from the desired state.
    ctx.agents.desired.markDirty({ all: true });
    // GitHub's webhook follows the domain (best effort; polling covers a failure).
    void syncWebhookConfig(ctx);
    // Without its old domain IP access reopens at once, unless another private path works.
    const before = readIpAccessApplied(ctx);
    const after = applyPanelIpAccess(ctx, input.domain ? `the panel domain changed to ${input.domain}` : "the panel domain was removed", {
      by: ctx.principal.type === "anonymous" ? "someone" : ctx.principal.user.email,
    });
    if (after.closed !== before.closed) ctx.auditDetails?.({ ipAccess: after.closed ? "closed" : "reopened" });
  }
  // Saving the domain again (changed or not) checks it now instead of at the next 5-minute run,
  // an active one too (forced past its hourly re-check).
  if (input.domain) ctx.jobs.enqueue(domainCheckJobType, { force: true }, { dedupeKey: "settings.checkDomain.now" });
  bootChanged(ctx);
  ctx.live.publish("panel", { type: "invalidate", ops: ["system.features", "mcp.info", "settings.panelAccess"] });
  return general(ctx);
});

/** "Check now" runs at most once in this window per panel; the DNS and HTTPS probes take up to ~16 seconds. */
export const domainCheckWindowMs = 10_000;

const lastChecks = new WeakMap<object, number>();

/**
 * "Check now" on the Panel domain card: the scheduled check, run in this
 * request (through the job's single flight, so a scheduled run at the same
 * moment is one probe, not two) so the answer is the fresh state. The
 * window is taken before the probes, so a double click or a script sending
 * several at once gets RATE_LIMITED instead of queueing more.
 */
export const checkDomainOp = implement(settings.checkDomain, async (_input, ctx) => {
  if (!getSetting(ctx.db, "panelDomain")) {
    throw new OpError("CONFLICT", "The panel has no domain to check. Save one first.", { reason: "noDomain" });
  }
  const now = Date.now();
  const last = lastChecks.get(ctx.db);
  if (last !== undefined && now - last < domainCheckWindowMs) {
    const wait = Math.max(1, Math.ceil((domainCheckWindowMs - (now - last)) / 1000));
    throw new OpError("RATE_LIMITED", `The domain was checked a moment ago. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.`, {
      reason: "domainCheck",
      retryAfter: String(wait),
    });
  }
  lastChecks.set(ctx.db, now);
  await checkDomainNow(ctx);
  return readDomainStatus(ctx);
});

/**
 * IP access is closed in "stay closed" mode and the panel domain is the
 * only private path that works: changing or removing the domain would lock
 * the panel to the SSH tunnel and the server's command line.
 */
function keptClosedByDomain(ctx: OpContext): boolean {
  if (readPanelAccessWanted(ctx).onFailure !== "stayClosed" || !readIpAccessApplied(ctx).closed) return false;
  if (!domainPath.state(ctx).working) return false;
  return !privatePathSources().some((source) => source.kind !== "domain" && source.state(ctx).working);
}

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
