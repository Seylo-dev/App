// When the installable app and push notifications work, and what refuses
// turning them on. They need the panel's own domain over HTTPS: browsers
// install apps and allow push only on a secure address, and both stay tied
// to the address they came from, so an IP:port or tailnet address (even a
// tailnet with HTTPS) is not offered.
//
// Turning on needs the domain active now (its last check found it serving
// the panel with a trusted certificate) and the request to have come in on
// it. Once on, pushes go out while the domain counts as working, with the
// domain check's debounce (two failed checks in a row stop it), so one
// failed check does not silence a crash alert; on a new domain the old
// devices are of no use and are removed (devices.ts).

import type { push as pushOps } from "@seylo/ops";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { domainWorking } from "../settings/domain";
import { domainPath } from "../settings/private-paths";
import "../settings/keys";
import { readAppPush } from "./keys";

/** "https://<panel domain>", or null without a domain. */
export function domainOrigin(deps: Pick<Deps, "db">): string | null {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  return domain ? `https://${domain}` : null;
}

/** The domain's last check found it serving the panel (not debounced). */
function domainActiveNow(deps: Pick<Deps, "db">): boolean {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  const status = getSetting(deps.db, "panelDomainStatus");
  return domain !== null && status?.domain === domain && status.state === "active";
}

/** The domain counts as working (debounced like the private path). */
function domainWorks(deps: Pick<Deps, "db">): boolean {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  return domainWorking(getSetting(deps.db, "panelDomainStatus"), domain).working;
}

/** On, and the domain works: the app installs and pushes go out. */
export function appPushActive(deps: Pick<Deps, "db">): boolean {
  return readAppPush(deps.db).enabled && domainWorks(deps);
}

/** The request came in on https://<panel domain> through the panel's proxy, not over IP:port or the tailnet. */
export function onDomainNow(ctx: OpContext): boolean {
  return ctx.via !== "tailnet" && (ctx.transport ?? "http") === "http" && domainPath.provenBy(ctx);
}

/** Why the admin switch cannot be turned on by this request now; empty when it can. */
export function turnOnBlocks(ctx: OpContext): pushOps.AppPushBlock[] {
  const blocks: pushOps.AppPushBlock[] = [];
  const origin = domainOrigin(ctx);
  if (ctx.principal.type !== "session" || (ctx.transport ?? "http") !== "http") {
    blocks.push({
      code: "notBrowser",
      message: "Turn this on from a browser signed in to the panel, not with an API key or the assistant.",
    });
  }
  if (!origin) {
    blocks.push({
      code: "noDomain",
      message:
        "The panel has no domain. Set one in Settings > General: browsers only install apps and allow notifications on a secure address.",
    });
    return blocks;
  }
  if (!domainActiveNow(ctx)) {
    blocks.push({
      code: "domainNotActive",
      message: `${origin} does not serve the panel over HTTPS yet. Once Settings > General shows it active, this can be turned on.`,
    });
  }
  if (ctx.via === "tailnet") {
    blocks.push({
      code: "viaTailnet",
      message: `This page is open on the tailnet. Open the panel at ${origin} to turn this on: an app installed from a tailnet address works only on the tailnet.`,
    });
  } else if (!domainPath.provenBy(ctx)) {
    blocks.push({
      code: "notOnDomain",
      message: `This page is not open on the panel domain. Open the panel at ${origin} to turn this on.`,
    });
  }
  return blocks;
}

/** What a person sees when push is not available: empty when it is. */
export function unavailableReason(deps: Pick<Deps, "db">): string {
  if (!readAppPush(deps.db).enabled) return "An admin has not turned on the app and push notifications (Settings > Notifications).";
  if (!domainOrigin(deps)) return "The panel has no domain, so the app and push notifications are paused.";
  if (!domainWorks(deps)) return "The panel's domain does not work right now, so push notifications are paused.";
  return "";
}
