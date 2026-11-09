import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { FramedErrorPage, FramedNotFound } from "../components/not-found";
import type { RouterContext } from "../lib/router-context";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  // Unknown paths go to the signed-in layout's catch-all (_app/$.tsx); these are for errors outside it.
  notFoundComponent: FramedNotFound,
  errorComponent: ({ error }) => <FramedErrorPage error={error} />,
});
