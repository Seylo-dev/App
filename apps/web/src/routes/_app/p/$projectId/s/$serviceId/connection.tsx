import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage } from "../../../../../../components/service/database/connection-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/connection")({
  component: withService(ConnectionPage),
});
