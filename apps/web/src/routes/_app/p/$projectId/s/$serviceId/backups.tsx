import { createFileRoute } from "@tanstack/react-router";
import { BackupsPage } from "../../../../../../components/service/backups/backups-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/backups")({
  component: withService(BackupsPage),
});
