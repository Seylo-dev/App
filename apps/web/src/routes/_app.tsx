// Every signed-in screen: the sidebar plus the page. Signed-out visitors
// are sent to /login and come back afterwards. The live socket lives as
// long as this layout does. A new page fades in with a small rise; the
// sidebar stays as it is.

import { EnterOnChange } from "@seylo/ui/components/motion";
import { createFileRoute, Outlet, redirect, useChildMatches, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorPage, NotFound } from "../components/not-found";
import { PlainHttpNotice } from "../components/shell/plain-http-notice";
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
  // The page's own route (a project, a service, settings): its tabs and sections animate themselves.
  const page = useChildMatches({ select: (matches) => matches[0]?.id ?? "" });

  useEffect(() => {
    live.connect(() => void navigate({ to: "/login" }));
    return () => live.disconnect();
  }, [navigate]);

  return (
    <ShellProvider>
      <PanelTopic />
      <div className="flex min-h-dvh flex-col md:flex-row">
        <Sidebar />
        <main className="box-border flex min-w-0 flex-1 flex-col px-4 pt-[26px] pb-10 md:px-[30px]">
          <PlainHttpNotice className="mb-5" />
          <EnterOnChange motionKey={page} className="flex min-w-0 flex-1 flex-col gap-5">
            <Outlet />
          </EnterOnChange>
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
