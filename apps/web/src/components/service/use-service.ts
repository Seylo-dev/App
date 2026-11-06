// The current service of a service screen. Every tab reads services.get
// through the same query key, so the layout and the tab share one request
// and one live invalidation.

import { services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useParams } from "@tanstack/react-router";
import { retryOp } from "./op-state";

export function useServiceParams(): { projectId: string; serviceId: string } {
  return useParams({ from: "/_app/p/$projectId/s/$serviceId" });
}

export function useService() {
  const { serviceId } = useServiceParams();
  return useOp(services.get, { serviceId }, { retry: retryOp });
}

export type ServiceDetail = (typeof services.ServiceDetail)["static"];
