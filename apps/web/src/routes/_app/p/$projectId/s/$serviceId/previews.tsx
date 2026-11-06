import { createFileRoute } from "@tanstack/react-router";
import { PreviewsPage } from "../../../../../../components/service/previews/previews-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/previews")({
  component: withService(PreviewsPage),
});
