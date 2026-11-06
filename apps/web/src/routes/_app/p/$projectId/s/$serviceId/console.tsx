import { createFileRoute } from "@tanstack/react-router";
import { TerminalSkeleton } from "../../../../../../components/service/service-skeletons";
import { ConsolePage } from "../../../../../../components/service/terminal/console-pages";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/console")({
  component: withService(ConsolePage, TerminalSkeleton),
});
