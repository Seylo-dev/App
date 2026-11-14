// Test fixture: a file mount and a deploy command; no logo, so a letter tile.

import { PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  retention?: string;
}

const config = `global:
  scrape_interval: 30s
scrape_configs:
  - job_name: self
    static_configs:
      - targets: ["localhost:9090"]
`;

export function generate(input: Input) {
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          domains: [{ host: PRIMARY_DOMAIN, port: 9090 }],
          mounts: [
            { type: "file", content: config, mountPath: "/etc/metrics/config.yml" },
            { type: "volume", name: "data", mountPath: "/metrics" },
          ],
          deploy: {
            command: `metrics --config.file=/etc/metrics/config.yml --storage.tsdb.retention.time=${input.retention || "15d"}`,
          },
        },
      },
    ],
  };
}
