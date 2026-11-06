import { createFileRoute } from "@tanstack/react-router";
import { StoragePage } from "../../../../../../components/service/files/storage-page";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/storage")({
  component: withService(StoragePage),
});
