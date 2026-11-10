import { createFileRoute } from "@tanstack/react-router";
import { loadMonaco } from "../../../../../../components/service/editor/load-monaco";
import { EnvironmentPage, EnvironmentSkeleton } from "../../../../../../components/service/env/environment-page";
import { prefetchEnvironment } from "../../../../../../components/service/tab-prefetch";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/environment")({
  loader: ({ context, params }) => {
    prefetchEnvironment(context, params);
    // The editor (Monaco) downloads alongside the variables, not after them.
    void loadMonaco().catch(() => {});
  },
  component: withService(EnvironmentPage, EnvironmentSkeleton),
});
