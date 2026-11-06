// Every signed-in screen: the sidebar plus the page. Signed-out visitors
// are sent to /login and come back afterwards. The live socket lives as
// long as this layout does.

import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorPage, NotFound } from "../components/not-found";
import { ShellProvider } from "../components/shell/shell-context";
import { Sidebar } from "../components/shell/sidebar";
import { live, useLiveTopic } from "../lib/live";
import { ensureViewer, isSignedOut } from "../lib/viewer";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await ensureViewer(context);
    } catch (error) {
      if (isSignedOut(error)) throw redirect({ to: "/login", search: { redirect: location.href } });
      throw error;
    }
  },
  component: AppLayout,
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <ErrorPage error={error} />,
});

function AppLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    live.connect(() => void navigate({ to: "/login" }));
    return () => live.disconnect();
  }, [navigate]);

  return (
    <ShellProvider>
      <PanelTopic />
      <div className="flex min-h-dvh flex-col md:flex-row">
        <Sidebar />
        <main className="box-border flex min-w-0 flex-1 flex-col gap-5 px-4 pt-[26px] pb-10 md:px-[30px]">
          <Outlet />
        </main>
      </div>
    </ShellProvider>
  );
}

/** The sidebar and dashboard show panel-wide data on every screen. */
function PanelTopic() {
  useLiveTopic("panel");
  return null;
}
