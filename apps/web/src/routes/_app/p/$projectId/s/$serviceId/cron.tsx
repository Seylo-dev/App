import { createFileRoute } from "@tanstack/react-router";
import { CronJobsPage } from "../../../../../../components/service/cron/cron-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/cron")({
  component: withService(CronJobsPage),
});
