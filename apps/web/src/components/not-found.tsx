// The 404 page and the catch-all error page. Inside the signed-in layout
// they render next to the sidebar; outside it, on their own.

import { Button } from "@seylo/ui/components/button";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { IconAlertTriangle, IconCompass } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/api";

export function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
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
    </div>
  );
}

export function ErrorPage({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
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
    </div>
  );
}
