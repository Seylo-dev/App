// Panel settings: general (name, domain, default node), branding and white
// label, appearance, telemetry opt-in, and the boot payload injected into
// index.html (boot.ts). The panel domain is re-checked by a recurring job
// (domain.ts). Contracts: packages/ops/src/ops/settings.ts.

import type { Deps } from "../../deps";
import { defineModule } from "../module";
import { boot } from "./boot-op";
import { domainCheckJob, domainCheckJobType } from "./domain";
import { brandingRoutes } from "./http";
import {
  appearanceOp,
  brandingOp,
  generalOp,
  removeBrandAsset,
  telemetryOp,
  updateAppearance,
  updateBranding,
  updateGeneral,
  updateTelemetry,
  uploadBrandAsset,
} from "./ops";

function start(deps: Deps) {
  deps.schedules.ensure({
    key: "settings.checkDomain",
    jobType: domainCheckJobType,
    intervalSeconds: 300,
    jitterSeconds: 30,
    missedRun: "skip",
  });
}

export default defineModule({
  name: "settings",
  ops: [
    boot,
    generalOp,
    updateGeneral,
    brandingOp,
    updateBranding,
    uploadBrandAsset,
    removeBrandAsset,
    appearanceOp,
    updateAppearance,
    telemetryOp,
    updateTelemetry,
  ],
  jobs: [domainCheckJob],
  http: brandingRoutes,
  start,
});
