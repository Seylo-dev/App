// n8n template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  timezone?: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "n8n", user: "n8n" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            DB_TYPE: "postgresdb",
            DB_POSTGRESDB_HOST: ref(db, "INTERNAL_HOST"),
            DB_POSTGRESDB_PORT: ref(db, "INTERNAL_PORT"),
            DB_POSTGRESDB_DATABASE: ref(db, "DATABASE"),
            DB_POSTGRESDB_USER: ref(db, "USER"),
            DB_POSTGRESDB_PASSWORD: ref(db, "PASSWORD"),
            N8N_ENCRYPTION_KEY: randomHex(32),
            N8N_HOST: ref(input.serviceName, "DOMAIN"),
            N8N_PROTOCOL: "https",
            WEBHOOK_URL: ref(input.serviceName, "URL"),
            GENERIC_TIMEZONE: input.timezone || "UTC",
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 5678 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/home/node/.n8n" }],
        },
      },
    ],
  };
}
