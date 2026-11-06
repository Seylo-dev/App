// Stirling PDF template: App. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ DOCKER_ENABLE_SECURITY: "false", LANGS: "en_GB" }),
          domains: [{ host: PRIMARY_DOMAIN, port: 8080 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/configs" }],
        },
      },
    ],
  };
}
