// What the object menus do, shell-wide (mounted by ShellProvider): a
// service menu's actions, and the dialogs the menus open. The dialogs live
// here, never inside a menu or a row, because rows come and go (a project
// folds, a list refetches after a move, the dashboard switches views) and
// a list row only has the service's summary. Each opening mounts its
// dialog fresh, so it starts from the object's current state.

import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { DeleteProjectDialog, RenameProjectDialog } from "../project/project-dialogs";
import { CancelMoveDialog, type MovingDeployment, movingOf } from "../service/cancel-move-dialog";
import { CloneDialog } from "../service/copy/clone-dialog";
import { MoveProjectDialog } from "../service/copy/move-project-dialog";
import type { Deployment } from "../service/deploy-steps";
import { moveCardId } from "../service/move-card-id";
import { DeleteServiceDialog } from "../service/settings/delete-service-dialog";
import { copyWithToast } from "./row-menu";
import { useServiceActions } from "./service-actions";
import type { ServiceAction, ServiceMenuSubject } from "./service-items";

export type ObjectDialog =
  | { kind: "service-clone" | "service-move" | "service-stop" | "service-delete"; service: ServiceMenuSubject }
  | { kind: "move-cancel"; service: { id: string; name: string }; deployment: MovingDeployment }
  | { kind: "project-rename" | "project-delete"; project: { id: string; name: string } };

interface ObjectActions {
  /** Runs a service menu's item; `active` is the deploy in progress when the menu knows it. */
  serviceAction(service: ServiceMenuSubject, action: ServiceAction, active?: Pick<Deployment, "id" | "move"> | null): void;
  openDialog(dialog: ObjectDialog): void;
}

const ObjectActionsContext = createContext<ObjectActions | null>(null);

export function ObjectActionsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<ObjectDialog | null>(null);
  const actions = useServiceActions();
  const navigate = useNavigate();
  const router = useRouter();

  const serviceAction = (service: ServiceMenuSubject, action: ServiceAction, active?: Pick<Deployment, "id" | "move"> | null) => {
    const params = { projectId: service.projectId, serviceId: service.id };
    switch (action) {
      case "open":
        void navigate({ to: "/p/$projectId/s/$serviceId", params });
        return;
      case "openNewTab":
        window.open(router.buildLocation({ to: "/p/$projectId/s/$serviceId", params }).href, "_blank", "noopener");
        return;
      case "deploy":
        actions.startDeploy(service);
        return;
      case "cancelDeploy":
        void actions.cancelDeploy(service.id, active?.id);
        return;
      case "cancelMove": {
        const moving = movingOf(active);
        if (moving) setDialog({ kind: "move-cancel", service, deployment: moving });
        return;
      }
      case "restart":
        actions.restart.mutate({ serviceId: service.id });
        return;
      case "start":
        actions.start.mutate({ serviceId: service.id });
        return;
      case "stopBox":
        actions.stopBox.mutate({ serviceId: service.id });
        return;
      case "openBox":
        actions.openBox.mutate({ serviceId: service.id });
        return;
      case "logs":
        void navigate({ to: "/p/$projectId/s/$serviceId/logs", params });
        return;
      case "console":
        void navigate({ to: "/p/$projectId/s/$serviceId/console", params });
        return;
      case "moveNode":
        void navigate({ to: "/p/$projectId/s/$serviceId/advanced", params, hash: moveCardId });
        return;
      case "copyAddress":
      case "copyInternalAddress":
        if (service.address) void copyWithToast(service.address);
        return;
      case "copyId":
        void copyWithToast(service.id);
        return;
      case "stop":
        setDialog({ kind: "service-stop", service });
        return;
      case "clone":
        setDialog({ kind: "service-clone", service });
        return;
      case "moveProject":
        setDialog({ kind: "service-move", service });
        return;
      case "delete":
        setDialog({ kind: "service-delete", service });
        return;
    }
  };
  // The context value stays the same object; it calls the newest render's functions.
  const latest = useRef(serviceAction);
  latest.current = serviceAction;
  const value = useMemo<ObjectActions>(() => ({ serviceAction: (...args) => latest.current(...args), openDialog: setDialog }), []);

  return (
    <ObjectActionsContext.Provider value={value}>
      {children}
      {dialog && <ObjectDialogs dialog={dialog} onClose={() => setDialog(null)} stop={actions.stop.mutateAsync} />}
    </ObjectActionsContext.Provider>
  );
}

export function useObjectActions(): ObjectActions {
  const actions = useContext(ObjectActionsContext);
  if (!actions) throw new Error("useObjectActions: render inside <ShellProvider>");
  return actions;
}

function ObjectDialogs({
  dialog,
  onClose,
  stop,
}: {
  dialog: ObjectDialog;
  onClose: () => void;
  stop: (input: { serviceId: string }) => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  switch (dialog.kind) {
    case "service-clone":
      return <CloneDialog service={dialog.service} open onOpenChange={onOpenChange} />;
    case "service-move":
      return <MoveProjectDialog service={dialog.service} open onOpenChange={onOpenChange} />;
    case "move-cancel":
      return <CancelMoveDialog service={dialog.service} deployment={dialog.deployment} open onOpenChange={onOpenChange} />;
    case "service-stop":
      return (
        <ConfirmDialog
          open
          onOpenChange={onOpenChange}
          title={t("service.header.stopTitle", { name: dialog.service.name })}
          description={t("service.header.stopBody")}
          confirmLabel={t("service.header.stop")}
          onConfirm={() => stop({ serviceId: dialog.service.id }).then(() => undefined)}
        />
      );
    case "service-delete": {
      const { service } = dialog;
      return (
        <DeleteServiceDialog
          service={service}
          open
          onOpenChange={onOpenChange}
          // Off the deleted service's own pages, to its project; elsewhere the lists drop it.
          onDeleted={() => {
            if (params.serviceId === service.id) void navigate({ to: "/p/$projectId", params: { projectId: service.projectId } });
          }}
        />
      );
    }
    case "project-rename":
      return <RenameProjectDialog project={dialog.project} open onOpenChange={onOpenChange} />;
    case "project-delete": {
      const { project } = dialog;
      return (
        <DeleteProjectDialog
          project={project}
          open
          onOpenChange={onOpenChange}
          onDeleted={() => {
            if (params.projectId === project.id) void navigate({ to: "/" });
          }}
        />
      );
    }
  }
}
