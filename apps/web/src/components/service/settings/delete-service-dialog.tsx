// Deleting a service: type its name to confirm. The Settings tab's Delete
// button and every service menu's Delete open this one dialog.

import { projects, services } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { t } from "../../../i18n/t";
import type { ServiceKind } from "../../../lib/types";
import { useInvalidate } from "../invalidate";

export function DeleteServiceDialog({
  service,
  open,
  onOpenChange,
  onDeleted,
}: {
  service: { id: string; name: string; kind: ServiceKind };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const invalidate = useInvalidate();
  const remove = useOpMutation(services.remove, {
    onSuccess: () => {
      invalidate(services.list, projects.list);
      onDeleted?.();
    },
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("serviceSettings.delete.confirmTitle", { name: service.name })}
      description={service.kind === "compose" ? t("serviceSettings.delete.confirmStack") : t("serviceSettings.delete.confirmBody")}
      confirmText={service.name}
      confirmLabel={t("serviceSettings.delete.confirm")}
      destructive
      onConfirm={() => remove.mutateAsync({ serviceId: service.id, confirmName: service.name }).then(() => undefined)}
    />
  );
}
