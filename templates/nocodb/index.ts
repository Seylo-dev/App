// NocoDB template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "nocodb" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            NC_DB: `pg://${ref(db, "INTERNAL_HOST")}:${ref(db, "INTERNAL_PORT")}?u=${ref(db, "USER")}&p=${ref(db, "PASSWORD")}&d=${ref(db, "DATABASE")}`,
            NC_AUTH_JWT_SECRET: randomHex(32),
            NC_PUBLIC_URL: ref(input.serviceName, "URL"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 8080 }],
          mounts: [{ type: "volume", name: "data", mountPath: "/usr/app/data" }],
        },
      },
    ],
  };
}
