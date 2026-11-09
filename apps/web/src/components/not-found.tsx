// The 404 page and the catch-all error page. Inside the signed-in layout
// they render next to the sidebar, centered in the content; outside it
// (an error before the layout could load) in the sign-in screens' frame,
// with the panel's mark on top, so they still look like this panel.

import { Button } from "@seylo/ui/components/button";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { IconAlertTriangle, IconCompass } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/api";
import { AuthFrame } from "./auth/auth-frame";

export function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <NotFoundCard />
    </div>
  );
}

export function ErrorPage({ error }: { error: unknown }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <ErrorCard error={error} />
    </div>
  );
}

/** The root route's 404 and error: the same cards, under the panel's mark. */
export function FramedNotFound() {
  return (
    <AuthFrame>
      <NotFoundCard />
    </AuthFrame>
  );
}

export function FramedErrorPage({ error }: { error: unknown }) {
  return (
    <AuthFrame>
      <ErrorCard error={error} />
    </AuthFrame>
  );
}

function NotFoundCard() {
  return (
    <div className="w-full max-w-[480px] rounded-card bg-card shadow-card">
      <EmptyState
        icon={<IconCompass />}
        title={t("common.notFoundTitle")}
        description={t("common.notFoundHint")}
        action={
          <Button variant="primary" asChild>
            <Link to="/">{t("common.toDashboard")}</Link>
          </Button>
        }
      />
    </div>
  );
}

function ErrorCard({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="w-full max-w-[480px] rounded-card bg-card shadow-card">
      <EmptyState
        icon={<IconAlertTriangle />}
        title={t("common.errorTitle")}
        description={errorMessage(error, t("common.unknownError"))}
        action={
          <>
            <Button variant="primary" onClick={() => void router.invalidate()}>
              {t("common.retry")}
            </Button>
            <Button asChild>
              <Link to="/">{t("common.toDashboard")}</Link>
            </Button>
          </>
        }
      />
    </div>
  );
}
