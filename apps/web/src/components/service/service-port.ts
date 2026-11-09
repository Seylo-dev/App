// The port a service's port fields start with, so they agree with the PORT
// the panel gives an app built from a repository: its first TCP port, else
// the panel's appPort (for a portless built app, the port its domains point
// at, else 80), else 80, what most images listen on.

import type { ServiceDetail } from "./use-service";

export const defaultServicePort = 80;

export function servicePort(service: Pick<ServiceDetail, "ports" | "appPort">): number {
  return service.ports.find((p) => p.protocol === "tcp")?.containerPort ?? service.appPort ?? defaultServicePort;
}
