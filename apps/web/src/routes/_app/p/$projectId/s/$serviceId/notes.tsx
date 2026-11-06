import { createFileRoute } from "@tanstack/react-router";
import { NotesPage } from "../../../../../../components/service/settings/settings-pages";
import { withService } from "../../../../../../components/service/with-service";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/notes")({
  component: withService(NotesPage),
});
