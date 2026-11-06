// Mattermost template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "mattermost", user: "mmuser" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            MM_SQLSETTINGS_DRIVERNAME: "postgres",
            MM_SQLSETTINGS_DATASOURCE: `postgres://${ref(db, "USER")}:${ref(db, "PASSWORD")}@${ref(db, "INTERNAL_HOST")}:${ref(db, "INTERNAL_PORT")}/${ref(db, "DATABASE")}?sslmode=disable&connect_timeout=10`,
            MM_SERVICESETTINGS_SITEURL: ref(input.serviceName, "URL"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 8065 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/mattermost/data" }],
        },
      },
    ],
  };
}
