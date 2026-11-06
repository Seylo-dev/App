// Tab routes render a screen that needs the loaded service. This wraps a
// screen so the route file stays one line: loading and errors are handled
// once, the same way on every tab.

import type { ComponentType } from "react";
import { OpView } from "./op-state";
import { type ServiceDetail, useService } from "./use-service";

export function withService(Screen: ComponentType<{ service: ServiceDetail }>) {
  return function ServiceScreen() {
    const service = useService();
    return <OpView query={service}>{(data) => <Screen service={data} />}</OpView>;
  };
}
