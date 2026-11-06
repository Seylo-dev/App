// Vaultwarden template: App. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  adminToken?: string;
  signups?: boolean;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            DOMAIN: ref(input.serviceName, "URL"),
            ADMIN_TOKEN: input.adminToken,
            SIGNUPS_ALLOWED: input.signups === false ? "false" : "true",
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 80 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
        },
      },
    ],
  };
}
