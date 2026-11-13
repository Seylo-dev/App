// What the health check card says applies when the service has no check of
// its own: the image's HEALTHCHECK its node reported (apps and compose
// members deployed from 0.2.15), else TCP on the first port, else "running".

import { t } from "../../../i18n/t";
import type { ServiceDetail } from "../use-service";

type ImageHealthCheck = NonNullable<ServiceDetail["imageHealthCheck"]>;

/** Docker's test as one command line: the shell command of CMD-SHELL, the program and arguments of CMD. */
export function imageCheckCommand(test: readonly string[]): string {
  const [kind, ...rest] = test;
  return kind === "CMD" || kind === "CMD-SHELL" ? rest.join(" ") : test.join(" ");
}

const secondsText = (n: number) => `${Number.isInteger(n) ? n : Number(n.toFixed(1))}s`;

export function imageCheckText(c: ImageHealthCheck): string {
  return t("serviceAdvanced.health.imageCheck", {
    command: imageCheckCommand(c.test),
    interval: secondsText(c.intervalSeconds),
    start: secondsText(c.startPeriodSeconds),
    count: c.retries,
  });
}

/** The default check's line, for a service whose healthCheck is null. */
export function defaultCheckText(service: Pick<ServiceDetail, "imageHealthCheck" | "ports">): string {
  if (service.imageHealthCheck) return imageCheckText(service.imageHealthCheck);
  const port = service.ports.find((p) => p.protocol === "tcp")?.containerPort;
  return port ? t("serviceAdvanced.health.tcpCheck", { port }) : t("serviceAdvanced.health.defaultHint");
}
