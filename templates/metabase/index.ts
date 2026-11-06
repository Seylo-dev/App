// Metabase template: App + Postgres. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "16", database: "metabase" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            MB_DB_TYPE: "postgres",
            MB_DB_HOST: ref(db, "INTERNAL_HOST"),
            MB_DB_PORT: ref(db, "INTERNAL_PORT"),
            MB_DB_DBNAME: ref(db, "DATABASE"),
            MB_DB_USER: ref(db, "USER"),
            MB_DB_PASS: ref(db, "PASSWORD"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
        },
      },
    ],
  };
}
