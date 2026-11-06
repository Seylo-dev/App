// Grafana template: App. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  adminPassword?: string;
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
            GF_SECURITY_ADMIN_USER: "admin",
            GF_SECURITY_ADMIN_PASSWORD: input.adminPassword,
            GF_SERVER_ROOT_URL: ref(input.serviceName, "URL"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/var/lib/grafana" }],
        },
      },
    ],
  };
}
