// A service's run actions (restart, stop, start, deploy, cancel deploy, the
// Box's stop and open) with their toasts and refreshes, in one place: the
// service header's buttons and every service menu (object-actions.tsx)
// call them through this hook, so they behave the same wherever they are.

import { boxes, deployments, services } from "@seylo/ops";
import { opQueryKey, useOpClient, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { useInvalidate } from "../service/invalidate";
import { isNotBuilt } from "../service/op-state";
import { isActiveDeployment } from "../service/status";

export function useServiceActions() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const client = useOpClient();
  const queryClient = useQueryClient();

  const onDone = (message: string) => () => {
    toast.success(message);
    invalidate(services.get, services.list);
  };
  const onFail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

  const restart = useOpMutation(services.restart, { onSuccess: onDone(t("service.header.restarted")), onError: onFail });
  const stop = useOpMutation(services.stop, { onSuccess: onDone(t("service.header.stopped")), onError: onFail });
  const start = useOpMutation(services.start, { onSuccess: onDone(t("service.header.started")), onError: onFail });
  const deploy = useOpMutation(deployments.deploy, { onSuccess: () => invalidate(deployments.list, services.get), onError: onFail });
  const cancel = useOpMutation(deployments.cancel, { onSuccess: () => invalidate(deployments.list, services.get), onError: onFail });
  const openBox = useOpMutation(boxes.open, {
    onSuccess: (res) => window.open(res.url, "_blank", "noopener"),
    onError: onFail,
  });
  const stopBox = useOpMutation(boxes.stop, { onSuccess: onDone(t("service.header.stopped")), onError: onFail });

  return {
    restart,
    stop,
    start,
    deploy,
    cancel,
    openBox,
    stopBox,
    /** Deploys now and says so, with a way to the Deployments tab. */
    startDeploy(service: { id: string; projectId: string }) {
      deploy.mutate(
        { serviceId: service.id },
        {
          onSuccess: () =>
            toast.success(t("service.header.deployStarted"), {
              action: {
                label: t("service.header.viewDeploy"),
                onClick: () =>
                  void navigate({
                    to: "/p/$projectId/s/$serviceId/deployments",
                    params: { projectId: service.projectId, serviceId: service.id },
                  }),
              },
            }),
        },
      );
    },
    /**
     * Cancels the deploy in progress (the oldest queued or running one, as
     * active-deploy.ts picks it). A row knows only that one runs, so the id
     * is asked for when it is not given.
     */
    async cancelDeploy(serviceId: string, deploymentId?: string) {
      let id = deploymentId;
      if (!id) {
        const input = { serviceId, active: true, limit: 1 };
        try {
          const list = await queryClient.fetchQuery({
            queryKey: opQueryKey(deployments.list, input),
            queryFn: () => client.call(deployments.list, input),
          });
          id = list.deployments.find((d) => isActiveDeployment(d.status))?.id;
        } catch (error) {
          onFail(error);
          return;
        }
      }
      // Nothing runs any more: the lists catch up.
      if (!id) invalidate(deployments.list, services.get, services.list);
      else cancel.mutate({ serviceId, deploymentId: id });
    },
  };
}
