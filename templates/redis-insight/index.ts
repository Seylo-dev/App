// Redis Insight template: App + Redis. Runs in the panel's template sandbox; see templates/README.md.

import { PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  withRedis?: boolean;
}

export function generate(input: Input) {
  const services: unknown[] = [];
  if (input.withRedis !== false) services.push({ type: "redis", data: { serviceName: `${input.serviceName}-redis`, version: "7.4" } });
  services.push({
    type: "app",
    data: {
      serviceName: input.serviceName,
      source: { type: "image", image: input.image },
      domains: [{ host: PRIMARY_DOMAIN, port: 5540 }],
      mounts: [{ type: "volume", name: "data", mountPath: "/data" }],
    },
  });
  return { services };
}
