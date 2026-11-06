// Writes openapi.json at the repository root from the op registry. The
// docs site renders its API reference from this file, and a release
// attaches it. Deterministic, so scripts/check-generated.sh can diff it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayName, docsUrl } from "@seylo/brand";
import { allOps, sessionCookie } from "@seylo/ops";
import { buildOpenApi } from "@seylo/ops/generators";
import panelPackage from "../apps/panel/package.json";

const document = buildOpenApi(allOps, {
  title: `${displayName} API`,
  version: panelPackage.version,
  description: `Every action in the ${displayName} panel. Queries are GET requests with query parameters; everything else is a POST with a JSON body. Docs: ${docsUrl}`,
  sessionCookie,
});

writeFileSync(join(import.meta.dir, "..", "openapi.json"), `${JSON.stringify(document, null, 2)}\n`);
