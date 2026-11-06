import { createFileRoute } from "@tanstack/react-router";
import { LogsPage } from "../../../../../../components/service/logs/logs-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/logs")({
  component: withService(LogsPage),
});
