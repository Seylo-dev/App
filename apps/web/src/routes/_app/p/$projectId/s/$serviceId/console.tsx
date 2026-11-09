import { createFileRoute } from "@tanstack/react-router";
import { ConsolePage, ConsoleSkeleton } from "../../../../../../components/service/terminal/console-pages";
import { withService } from "../../../../../../components/service/with-service";

interface ConsoleSearch {
  /** The terminal's mode; left out is the console. */
  mode?: "shell";
}

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/console")({
  validateSearch: (search: Record<string, unknown>): ConsoleSearch => ({ mode: search.mode === "shell" ? "shell" : undefined }),
  component: withService(ConsolePage, ConsoleSkeleton),
});
