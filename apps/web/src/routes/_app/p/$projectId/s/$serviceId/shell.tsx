// The Shell used to be a tab of its own; it is the Console tab's shell mode
// now. Old links and bookmarks land there.

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/p/$projectId/s/$serviceId/shell")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/p/$projectId/s/$serviceId/console", params, search: { mode: "shell" }, replace: true });
  },
});
