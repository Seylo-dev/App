// pgAdmin template: App. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  email: string;
  password?: string;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ PGADMIN_DEFAULT_EMAIL: input.email, PGADMIN_DEFAULT_PASSWORD: input.password }),
          domains: [{ host: PRIMARY_DOMAIN, port: 80 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/var/lib/pgadmin" }],
        },
      },
    ],
  };
}
