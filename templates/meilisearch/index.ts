// Meilisearch template: App. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  masterKey?: string;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ MEILI_MASTER_KEY: input.masterKey, MEILI_ENV: "production", MEILI_NO_ANALYTICS: "true" }),
          domains: [{ host: PRIMARY_DOMAIN, port: 7700 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/meili_data" }],
        },
      },
    ],
  };
}
