// Panel settings: general (name, domain, default node), branding and white
// label, appearance, telemetry opt-in, panel access (IP access and the
// agents' port, ip-access.ts) and the boot payload injected into
// index.html (boot.ts). The panel domain is re-checked by a recurring job
// (domain.ts); IP access by a 1-minute one, plus the panel node's connects
// and failed rolls. Contracts: packages/ops/src/ops/settings.ts.

import { watchDialedUrls } from "../../agent-hub/dialed";
import type { Deps } from "../../deps";
import { defineJob } from "../../jobs/queue";
import { defineModule } from "../module";
import { settle as settleTailnet } from "../tailscale/status";
import { boot } from "./boot-op";
import { domainCheckJob, domainCheckJobType } from "./domain";
import { brandingRoutes } from "./http";
import { applyPanelIpAccess, ipAccessJobType, watchPanelIpAccess } from "./ip-access";
import { applyIpAccessFile } from "./ip-access-file";
import {
  appearanceOp,
  brandingOp,
  checkDomainOp,
  generalOp,
  removeBrandAsset,
  telemetryOp,
  updateAppearance,
  updateBranding,
  updateGeneral,
  updateTelemetry,
  uploadBrandAsset,
} from "./ops";
import { panelAccessOp, updatePanelAccess } from "./panel-access";

/**
 * The 1-minute IP access check: the domain debounce, the tailnet's reports
 * and the anti-flap wait all end on a timer. The tailnet's own debounce is
 * ended first (the tailscale.check job does the same, on its own timer):
 * otherwise this check could reopen IP access on the tailnet's read-time
 * state before its stop was saved, and the panel restart that reopening
 * takes would start the 5 minutes over, showing the tailnet as working.
 */
export function ipAccessCheck(deps: Deps): void {
  // The marker of `seylo panel ip-access on`, in case the panel restart it asked for did not happen.
  if (applyIpAccessFile(deps)) return;
  settleTailnet(deps);
  applyPanelIpAccess(deps, "a scheduled check");
}

const ipAccessJob = defineJob<Record<string, never>>({
  type: ipAccessJobType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    ipAccessCheck(ctx);
  },
});

function start(deps: Deps) {
  deps.schedules.ensure({
    key: "settings.checkDomain",
    jobType: domainCheckJobType,
    intervalSeconds: 300,
    jitterSeconds: 30,
    missedRun: "skip",
  });
  watchDialedUrls(deps);
  watchPanelIpAccess(deps);
  // `seylo panel ip-access on` restarted this panel: reopen before anything else decides.
  try {
    applyIpAccessFile(deps);
  } catch (error) {
    deps.logger.error({ err: error }, "reading the ip-access-on marker failed");
  }
  deps.schedules.ensure({ key: ipAccessJobType, jobType: ipAccessJobType, intervalSeconds: 60, missedRun: "skip" });
}

export default defineModule({
  name: "settings",
  ops: [
    boot,
    generalOp,
    updateGeneral,
    checkDomainOp,
    brandingOp,
    updateBranding,
    uploadBrandAsset,
    removeBrandAsset,
    appearanceOp,
    updateAppearance,
    telemetryOp,
    updateTelemetry,
    panelAccessOp,
    updatePanelAccess,
  ],
  jobs: [domainCheckJob, ipAccessJob],
  http: brandingRoutes,
  start,
});
