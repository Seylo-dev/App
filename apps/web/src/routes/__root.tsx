import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { ErrorPage, NotFound } from "../components/not-found";
import type { RouterContext } from "../lib/router-context";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <main className="flex min-h-dvh">
      <NotFound />
    </main>
  ),
  errorComponent: ({ error }) => (
    <main className="flex min-h-dvh">
      <ErrorPage error={error} />
    </main>
  ),
});
