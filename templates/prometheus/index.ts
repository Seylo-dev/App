// Prometheus template: App. Runs in the panel's template sandbox; see templates/README.md.

import { PRIMARY_DOMAIN } from "~templates-utils";

interface Input {
  serviceName: string;
  image: string;
  retention?: string;
}

const config = `global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
`;

export function generate(input: Input) {
  const retention = /^[0-9]+[smhdwy]$/.test(input.retention ?? "") ? input.retention : "15d";
  return {
    services: [
      {
        type: "app",
        data: {
          serviceName: input.serviceName,
          source: { type: "image", image: input.image },
          domains: [{ host: PRIMARY_DOMAIN, port: 9090 }],
          mounts: [
            { type: "volume", name: "data", mountPath: "/prometheus" },
            { type: "file", content: config, mountPath: "/etc/prometheus/prometheus.yml" },
          ],
          deploy: {
            command: `exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --storage.tsdb.retention.time=${retention}`,
          },
        },
      },
    ],
  };
}
