import { createFileRoute } from "@tanstack/react-router";
import { UsersPage, UsersSkeleton } from "../../../../../../components/service/database/users-page";
import { withService } from "../../../../../../components/service/with-service";

interface UsersSearch {
  /** The Connection tab's Change links: opens the main user's name or password dialog on arrival. */
  change?: "name" | "password";
}

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/users")({
  validateSearch: (search: Record<string, unknown>): UsersSearch => ({
    change: search.change === "name" || search.change === "password" ? search.change : undefined,
  }),
  component: withService(UsersPage, UsersSkeleton),
});
