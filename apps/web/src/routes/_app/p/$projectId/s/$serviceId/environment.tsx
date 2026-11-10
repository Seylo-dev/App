import { createFileRoute } from "@tanstack/react-router";
import { loadMonaco } from "../../../../../../components/service/editor/load-monaco";
import { EnvironmentPage, EnvironmentSkeleton } from "../../../../../../components/service/env/environment-page";
import { prefetchEnvironment } from "../../../../../../components/service/tab-prefetch";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/environment")({
  loader: ({ context, params, preload }) => {
    prefetchEnvironment(context, params);
    // The editor (Monaco, 3.4 MB of code) downloads alongside the variables once you open the tab;
    // a hover only starts the variables, since evaluating Monaco would stall the pointer for a moment.
    if (!preload) void loadMonaco().catch(() => {});
  },
  component: withService(EnvironmentPage, EnvironmentSkeleton),
});
