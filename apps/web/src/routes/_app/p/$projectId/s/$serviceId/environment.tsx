import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentPage, EnvironmentSkeleton } from "../../../../../../components/service/env/environment-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/environment")({
  component: withService(EnvironmentPage, EnvironmentSkeleton),
});
