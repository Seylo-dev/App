// Test fixture: App + Postgres, wired with references and an automatic domain.

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
      { type: "postgres", data: { serviceName: db, version: "16", database: "flows", user: "flows" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            DB_HOST: ref(db, "INTERNAL_HOST"),
            DB_PASSWORD: ref(db, "PASSWORD"),
            ENCRYPTION_KEY: randomHex(32),
            PUBLIC_URL: ref(input.serviceName, "URL"),
            TIMEZONE: input.timezone || "UTC",
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 5678 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/home/app/.flows" }],
        },
      },
    ],
  };
}
