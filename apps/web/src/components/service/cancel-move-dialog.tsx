// Cancel move: the confirm for cancelling a move to another node
// (Deployment.move), from the service header, the service's menus and its
// Deployments tab. The panel takes a cancel only while it is safe
// (move.canCancel): a move with volumes while it copies (the copy stops,
// the old copy starts again with its data, the new node removes what was
// copied), a move without volumes until it ends (the old copy kept
// serving). The dialog says which, and shows the panel's refusal when the
// copy finished in the meantime.

import { deployments, services } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../../i18n/t";
import type { Deployment } from "./deploy-steps";
import { useInvalidate } from "./invalidate";

export type MovingDeployment = Pick<Deployment, "id"> & { move: NonNullable<Deployment["move"]> };

/** The deploy in progress when it is a move to another node, else null. */
export function movingOf(active: Pick<Deployment, "id" | "move"> | null | undefined): MovingDeployment | null {
  return active?.move ? { id: active.id, move: active.move } : null;
}

export function CancelMoveDialog({
  service,
  deployment,
  open,
  onOpenChange,
}: {
  service: { id: string; name: string };
  deployment: MovingDeployment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const { from, to, copying } = deployment.move;
  const cancel = useOpMutation(deployments.cancel, {
    onSuccess: () => {
      invalidate(deployments.list, deployments.get, services.get, services.list, services.moveImpact);
      toast.success(t("service.moveCancel.done", { name: service.name, from: from.name }));
    },
  });
  const words = { name: service.name, node: to.name, from: from.name };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("service.moveCancel.title", words)}
      description={t(copying ? "service.moveCancel.copying" : "service.moveCancel.rolling", words)}
      confirmLabel={t("service.header.cancelMove")}
      cancelLabel={t("service.moveCancel.keep")}
      destructive
      onConfirm={() => cancel.mutateAsync({ serviceId: service.id, deploymentId: deployment.id }).then(() => undefined)}
    />
  );
}
