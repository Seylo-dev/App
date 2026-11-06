// Tab routes render a screen that needs the loaded service. This wraps a
// screen so the route file stays one line: loading and errors are handled
// once, the same way on every tab. `Skeleton` is what the tab shows while
// the service loads (a card of rows unless the tab looks different); it is
// a component, not an element, so route files stay free of JSX (the
// router's code splitter moves the options into a virtual file).

import type { ComponentType } from "react";
import { OpView } from "./op-state";
import { TabSkeleton } from "./service-skeletons";
import { type ServiceDetail, useService } from "./use-service";

export function withService(Screen: ComponentType<{ service: ServiceDetail }>, Skeleton: ComponentType = TabSkeleton) {
  return function ServiceScreen() {
    const service = useService();
    return (
      <OpView query={service} skeleton={<Skeleton />}>
        {(data) => <Screen service={data} />}
      </OpView>
    );
  };
}
