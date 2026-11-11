// Writes openapi.json at the repository root from the op registry, and
// service-export.schema.json, the JSON Schema of the service export file
// format (packages/ops/src/ops/serviceTransfer.ts). The docs site renders
// its API reference from openapi.json, and a release attaches both.
// Deterministic, so scripts/check-generated.sh can diff them.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { displayName, docsUrl } from "@seylo/brand";
import { allOps, serviceTransfer, sessionCookie, sessionKeyHeader } from "@seylo/ops";
import { buildOpenApi, toJsonSchema } from "@seylo/ops/generators";
import panelPackage from "../apps/panel/package.json";

const document = buildOpenApi(allOps, {
  title: `${displayName} API`,
  version: panelPackage.version,
  description: `Every action in the ${displayName} panel. Queries are GET requests with query parameters; everything else is a POST with a JSON body. Docs: ${docsUrl}`,
  sessionCookie,
  sessionKeyHeader,
});

writeFileSync(join(import.meta.dir, "..", "openapi.json"), `${JSON.stringify(document, null, 2)}\n`);

const exportFormat = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: `${displayName} service export, format ${serviceTransfer.exportFormatVersion}`,
  description: `The files inside a service export (.zip): manifest.json (manifest), manifest.sig (signature), services/<name>/service.json (service), secrets.enc (envelope) and the plaintext inside it (secrets).`,
  $defs: {
    manifest: toJsonSchema(serviceTransfer.PortableManifestV1),
    signature: toJsonSchema(serviceTransfer.ManifestSignature),
    service: toJsonSchema(serviceTransfer.PortableServiceV1),
    envelope: toJsonSchema(serviceTransfer.SecretsEnvelopeV1),
    secrets: toJsonSchema(serviceTransfer.PortableSecretsV1),
  },
};
writeFileSync(join(import.meta.dir, "..", "service-export.schema.json"), `${JSON.stringify(exportFormat, null, 2)}\n`);
