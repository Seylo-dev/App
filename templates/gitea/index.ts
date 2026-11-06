// Gitea template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "gitea", user: "gitea" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            GITEA__database__DB_TYPE: "postgres",
            GITEA__database__HOST: `${ref(db, "INTERNAL_HOST")}:${ref(db, "INTERNAL_PORT")}`,
            GITEA__database__NAME: ref(db, "DATABASE"),
            GITEA__database__USER: ref(db, "USER"),
            GITEA__database__PASSWD: ref(db, "PASSWORD"),
            GITEA__server__ROOT_URL: ref(input.serviceName, "URL"),
            GITEA__server__DOMAIN: ref(input.serviceName, "DOMAIN"),
            GITEA__security__INSTALL_LOCK: "false",
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
          ports: [22],
          mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
        },
      },
    ],
  };
}
