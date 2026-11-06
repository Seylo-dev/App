// Directus template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  adminEmail: string;
  adminPassword?: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "directus" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            SECRET: randomHex(32),
            DB_CLIENT: "pg",
            DB_HOST: ref(db, "INTERNAL_HOST"),
            DB_PORT: ref(db, "INTERNAL_PORT"),
            DB_DATABASE: ref(db, "DATABASE"),
            DB_USER: ref(db, "USER"),
            DB_PASSWORD: ref(db, "PASSWORD"),
            ADMIN_EMAIL: input.adminEmail,
            ADMIN_PASSWORD: input.adminPassword,
            PUBLIC_URL: ref(input.serviceName, "URL"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 8055 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/directus/uploads" }],
        },
      },
    ],
  };
}
