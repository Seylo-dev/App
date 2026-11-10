import { createFileRoute } from "@tanstack/react-router";
import { DomainsPage } from "../../../../../../components/service/domains/domains-page";
import { prefetchDomains } from "../../../../../../components/service/tab-prefetch";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/domains")({
  loader: ({ context, params }) => {
    prefetchDomains(context, params);
  },
  component: withService(DomainsPage),
});
