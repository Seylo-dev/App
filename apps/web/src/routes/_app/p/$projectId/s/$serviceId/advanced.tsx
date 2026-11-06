import { createFileRoute } from "@tanstack/react-router";
import { AdvancedPage } from "../../../../../../components/service/advanced/advanced-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/advanced")({
  component: withService(AdvancedPage),
});
