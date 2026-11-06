import { createFileRoute } from "@tanstack/react-router";
import { ComposeFilePage } from "../../../../../../components/service/source/compose-file";
import { SourcePage } from "../../../../../../components/service/source/source-page";
import type { ServiceDetail } from "../../../../../../components/service/use-service";
import { withService } from "../../../../../../components/service/with-service";

function Source({ service }: { service: ServiceDetail }) {
  return service.kind === "compose" ? <ComposeFilePage service={service} /> : <SourcePage service={service} />;
}

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/source")({
  component: withService(Source),
});
