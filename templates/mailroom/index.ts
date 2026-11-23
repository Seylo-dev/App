// Mailroom template: the web app, an API and a sync worker (one server image), Postgres and Redis.
// Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, randomHex, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  serverImage: string;
  webImage: string;
  setupToken: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  const redis = `${input.serviceName}-redis`;
  const api = `${input.serviceName}-api`;
  const worker = `${input.serviceName}-worker`;
  // The API stores mailbox passwords encrypted with it and the worker decrypts them: one value for both
  const shared = {
    DATABASE_URL: ref(db, "INTERNAL_URL"),
    REDIS_URL: ref(redis, "INTERNAL_URL"),
    APP_SECRET: randomHex(32),
  };
  return {
    services: [
      { type: "postgres", data: { serviceName: db, version: "18", database: "mailroom" } },
      // Redis rather than Valkey: every node agent runs it
      { type: "redis", data: { serviceName: redis } },
      {
        type: "app",
        data: {
          serviceName: api,
          source: { type: "image", image: input.serverImage },
          env: env({ ...shared, SETUP_TOKEN: input.setupToken, PORT: 3001 }),
          ports: [3001],
        },
      },
      {
        type: "app",
        data: {
          serviceName: worker,
          source: { type: "image", image: input.serverImage },
          env: env({ ...shared, PORT: 3002 }),
          ports: [3002],
          // Keeps every mailbox in sync and sends the outbox; only one runs at a time (a Postgres lock)
          deploy: { command: "bun src/worker.ts" },
        },
      },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.webImage },
          // The browser only talks to the web app, which passes /api/* on to the API
          env: env({ API_URL: ref(api, "INTERNAL_URL") }),
          domains: [{ host: PRIMARY_DOMAIN, port: 3000 }],
        },
      },
    ],
  };
}
