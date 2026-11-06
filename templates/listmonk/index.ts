// listmonk template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  adminUser?: string;
  adminPassword?: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "listmonk" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            LISTMONK_app__address: "0.0.0.0:9000",
            LISTMONK_db__host: ref(db, "INTERNAL_HOST"),
            LISTMONK_db__port: ref(db, "INTERNAL_PORT"),
            LISTMONK_db__user: ref(db, "USER"),
            LISTMONK_db__password: ref(db, "PASSWORD"),
            LISTMONK_db__database: ref(db, "DATABASE"),
            LISTMONK_db__ssl_mode: "disable",
            LISTMONK_ADMIN_USER: input.adminUser || "admin",
            LISTMONK_ADMIN_PASSWORD: input.adminPassword,
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 9000 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/listmonk/uploads" }],
          deploy: {
            command:
              "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && exec ./listmonk --config ''",
          },
        },
      },
    ],
  };
}
