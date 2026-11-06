// Plausible Analytics template: App + Postgres + ClickHouse. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomBase64, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  clickhouseImage: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  const events = `${input.serviceName}-events`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "plausible" } },
      {
        type: "app",
        data: {
          serviceName: events,
          source: { type: "image", image: input.clickhouseImage },
          env: env({ CLICKHOUSE_SKIP_USER_SETUP: "1" }),
          ports: [8123],
          mounts: [{ type: "volume", name: "data", mountPath: "/var/lib/clickhouse" }],
        },
      },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            BASE_URL: ref(input.serviceName, "URL"),
            SECRET_KEY_BASE: randomBase64(48),
            TOTP_VAULT_KEY: randomBase64(32),
            DATABASE_URL: ref(db, "INTERNAL_URL"),
            CLICKHOUSE_DATABASE_URL: `http://${events}:8123/plausible_events_db`,
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 8000 }],
          deploy: { command: "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run" },
        },
      },
    ],
  };
}
