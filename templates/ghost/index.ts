// Ghost template: App + MySQL. Runs in the panel's template sandbox; see templates/README.md.

import { env, PRIMARY_DOMAIN, ref } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  const db = `${input.serviceName}-db`;
  return {
    services: [
      { type: "mysql", data: { serviceName: db, version: "8.0", database: "ghost" } },
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({
            url: ref(input.serviceName, "URL"),
            database__client: "mysql",
            database__connection__host: ref(db, "INTERNAL_HOST"),
            database__connection__port: ref(db, "INTERNAL_PORT"),
            database__connection__user: ref(db, "USER"),
            database__connection__password: ref(db, "PASSWORD"),
            database__connection__database: ref(db, "DATABASE"),
          }),
          domains: [{ host: PRIMARY_DOMAIN, port: 2368 }],
          mounts: [{ type: "volume", name: "content", mountPath: "/var/lib/ghost/content" }],
        },
      },
    ],
  };
}
