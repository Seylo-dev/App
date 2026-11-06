// Umami template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "umami" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ DATABASE_URL: ref(db, "INTERNAL_URL"), APP_SECRET: randomHex(32) }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
        },
      },
    ],
  };
}
