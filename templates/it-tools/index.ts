// IT Tools template: App. Runs in the panel's template sandbox; see templates/README.md.

import { PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
}

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          domains: [{ host: PRIMARY_DOMAIN, port: 80 }],
        },
      },
    ],
  };
}
