import { createFileRoute } from "@tanstack/react-router";
import { LogsPage } from "../../../../../../components/service/logs/logs-page";
import { TerminalSkeleton } from "../../../../../../components/service/service-skeletons";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/logs")({
  component: withService(LogsPage, TerminalSkeleton),
});
