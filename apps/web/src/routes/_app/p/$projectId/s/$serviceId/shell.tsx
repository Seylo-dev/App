import { createFileRoute } from "@tanstack/react-router";
import { ShellPage } from "../../../../../../components/service/terminal/console-pages";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/shell")({
  component: withService(ShellPage),
});
