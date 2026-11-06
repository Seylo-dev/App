// /reauth?redirect=<path>: "confirm it's you" as a page, for screens the
// web app does not render itself (the panel's MCP consent page sends a
// stale session here before it offers Allow). After auth.reauth it loads
// the redirect for real, since that page is served by the panel.

import { Card } from "@seylo/ui/components/card";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AuthFrame } from "../components/auth/auth-frame";
import { ReauthForm } from "../components/auth/reauth-dialog";
import { t } from "../i18n/t";
import { safeRedirectPath } from "../lib/redirect";
import { ensureViewer, isSignedOut } from "../lib/viewer";

export const Route = createFileRoute("/reauth")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    // The key is always returned: the router keeps raw search values a route leaves out.
    return { redirect: safeRedirectPath(search.redirect, window.location.origin) };
  },
  beforeLoad: async ({ context, location }) => {
    try {
      await ensureViewer(context);
    } catch (error) {
      if (isSignedOut(error)) throw redirect({ to: "/login", search: { redirect: location.href } });
      throw error;
    }
  },
  component: ReauthPage,
});

function ReauthPage() {
  const { redirect: wanted } = Route.useSearch();
  // Checked again where it is used: this page hands the address to location.assign.
  const next = safeRedirectPath(wanted, window.location.origin) ?? "/";
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame>
      <Card className="w-full max-w-[400px] gap-4 p-7">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("auth.reauth.title")}</h1>
          <p className="m-0 text-[13.5px] text-muted-foreground">{t("auth.reauth.pageHint")}</p>
        </div>
        <ReauthForm
          busy={busy}
          setBusy={setBusy}
          returnTo={next}
          onDone={() => window.location.assign(next)}
          onCancel={() => window.location.assign("/")}
        />
      </Card>
    </AuthFrame>
  );
}
