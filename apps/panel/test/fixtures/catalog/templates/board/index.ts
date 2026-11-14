// Test fixture: a required email, a select and a generated password; logo.webp.

import { env, PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  email: string;
  plan?: string;
  password: string;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          env: env({ ADMIN_EMAIL: input.email, ADMIN_PASSWORD: input.password, PLAN: input.plan ?? "small" }),
          domains: [{ host: PRIMARY_DOMAIN, port: 80 }],
        },
      },
    ],
  };
}
