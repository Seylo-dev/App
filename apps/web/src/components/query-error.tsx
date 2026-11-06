// What a section shows when its op failed. An op the panel does not
// implement yet (501 NOT_IMPLEMENTED) reads as "not built yet" with the
// panel's own message, so an unfinished backend never looks like an empty
// list or a crash; anything else shows the safe error message and a retry.

import { OpError } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { IconHammer } from "@tabler/icons-react";
import { t } from "../i18n/t";
import { errorMessage } from "../lib/api";

export function isNotBuilt(error: unknown): boolean {
  return error instanceof OpError && error.code === "NOT_IMPLEMENTED";
}

export function QueryError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  if (isNotBuilt(error)) {
    return (
      <Alert tone="neutral" title={t("placeholder.notBuilt")} icon={<IconHammer size={17} stroke={1.8} />} className={className}>
        {errorMessage(error, t("common.unknownError"))}
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      className={className}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )
      }
    >
      {errorMessage(error, t("common.unknownError"))}
    </Alert>
  );
}
