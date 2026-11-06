import { createFileRoute } from "@tanstack/react-router";
import { DomainsPage } from "../../../../../../components/service/domains/domains-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/domains")({
  component: withService(DomainsPage),
});
