// "Move to project" from the service menu: pick the new project, read what
// changes (services.moveProjectImpact: who loses access, which of its own
// variables change meaning, grants and invites that go, what blocks it),
// tick that you read it, move. services.moveProject switches a running
// service like a deploy; the page follows it to the new project.

import { projects, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { ProjectPicker } from "../../pickers";
import { CheckLabel, Field } from "../field";
import { useInvalidate } from "../invalidate";
import { OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

type Impact = (typeof services.MoveImpact)["static"];

/** Whether the move changes anything besides the service itself (then it needs the tick). */
export function changesSomething(i: Impact): boolean {
  return (
    i.referencedBy.length > 0 ||
    i.hiddenReferrers > 0 ||
    i.targetReferrers.length > 0 ||
    i.hiddenTargetReferrers > 0 ||
    i.ownReferences.length > 0 ||
    i.sharedLost.count > 0 ||
    i.grants.count > 0 ||
    i.invites > 0
  );
}

export function MoveProjectDialog({
  service,
  open,
  onOpenChange,
}: {
  service: ServiceDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [projectId, setProjectId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const impact = useOp(services.moveProjectImpact, { serviceId: service.id, projectId }, { enabled: open && !!projectId, retry: retryOp });
  const projectList = useOp(projects.list, {}, { enabled: open });
  const nameOf = (id: string) => projectList.data?.projects.find((p) => p.id === id)?.name ?? "";
  const from = nameOf(service.projectId);
  const to = nameOf(projectId);
  // A different project is a different list of changes to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on purpose when the target changes
  useEffect(() => setConfirmed(false), [projectId]);

  const move = useOpMutation(services.moveProject, {
    onSuccess: (res) => {
      onOpenChange(false);
      invalidate(services.get, services.list);
      toast.success(
        res.deploymentId
          ? t("serviceCopy.move.moving", { name: service.name, project: to })
          : t("serviceCopy.move.moved", { name: service.name, project: to }),
      );
      void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId, serviceId: service.id } });
    },
  });

  const i = impact.data;
  const needsTick = i ? changesSomething(i) : false;
  const blocked = (i?.blockers.length ?? 0) > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!i || blocked) return;
    move.mutate({ serviceId: service.id, projectId, confirm: needsTick ? confirmed : undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[8%] max-h-[84vh] max-w-xl overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label={t("serviceCopy.move.title", { name: service.name })}>
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceCopy.move.title", { name: service.name })}</DialogTitle>
            <DialogDescription>{t("serviceCopy.move.description")}</DialogDescription>
          </div>
          <Field label={t("serviceCopy.move.project")} htmlFor="move-project">
            <ProjectPicker id="move-project" value={projectId} onChange={setProjectId} exclude={service.projectId} />
          </Field>

          {!projectId ? null : impact.isError ? (
            <OpErrorNote error={impact.error} />
          ) : !i ? (
            <div role="status" className="flex flex-col gap-2" aria-busy="true" aria-label={t("common.loading")}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-[13px]" data-testid="move-impact">
              {blocked && (
                <Alert tone="danger" title={t("serviceCopy.move.blocked")}>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {i.blockers.map((b) => (
                      <li key={b.reason}>{b.message}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              {(i.referencedBy.length > 0 || i.hiddenReferrers > 0) && (
                <ImpactList title={t("serviceCopy.move.referencedBy", { project: from })}>
                  {i.referencedBy.map((r) => (
                    <li key={r.serviceId}>
                      <span className="font-medium">{r.name}</span>
                      {r.keys.length > 0 && <span className="font-mono text-muted-foreground"> {r.keys.join(", ")}</span>}
                    </li>
                  ))}
                  {i.hiddenReferrers > 0 && (
                    <li className="text-muted-foreground">{t("serviceCopy.move.hiddenReferrers", { count: i.hiddenReferrers })}</li>
                  )}
                </ImpactList>
              )}
              {(i.targetReferrers.length > 0 || i.hiddenTargetReferrers > 0) && (
                <ImpactList title={t("serviceCopy.move.targetReferrers", { project: to })}>
                  {i.targetReferrers.map((r) => (
                    <li key={r.serviceId}>
                      <span className="font-medium">{r.name}</span>
                      {r.keys.length > 0 && <span className="font-mono text-muted-foreground"> {r.keys.join(", ")}</span>}
                    </li>
                  ))}
                  {i.hiddenTargetReferrers > 0 && (
                    <li className="text-muted-foreground">
                      {t("serviceCopy.move.hiddenTargetReferrers", { count: i.hiddenTargetReferrers })}
                    </li>
                  )}
                </ImpactList>
              )}
              {i.ownReferences.length > 0 && (
                <ImpactList title={t("serviceCopy.move.ownReferences")}>
                  {i.ownReferences.map((r) => (
                    <li key={`${r.key}:${r.target}`}>
                      <span className="font-mono">{r.key}</span> <span className="font-mono text-muted-foreground">{r.target}</span>{" "}
                      {r.effect === "unresolved" ? t("serviceCopy.move.unresolved") : t("serviceCopy.move.retargeted", { project: to })}
                    </li>
                  ))}
                </ImpactList>
              )}
              {i.sharedLost.count > 0 && (
                <Line>
                  {t("serviceCopy.move.sharedLost", { count: i.sharedLost.count })}
                  {i.sharedLost.names.length > 0 && (
                    <span className="font-mono text-muted-foreground"> {i.sharedLost.names.join(", ")}</span>
                  )}
                </Line>
              )}
              {i.grants.count > 0 && (
                <Line>
                  {t("serviceCopy.move.grants", { count: i.grants.count })}
                  {i.grants.names.length > 0 && <span className="text-muted-foreground"> ({i.grants.names.join(", ")})</span>}
                </Line>
              )}
              {i.invites > 0 && <Line>{t("serviceCopy.move.invites", { count: i.invites })}</Line>}
              {!blocked && !needsTick && <Line>{t("serviceCopy.move.nothing")}</Line>}
              {!blocked && (
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  {i.switches ? t("serviceCopy.move.switches") : t("serviceCopy.move.still")}
                </p>
              )}
              {!blocked && needsTick && (
                <CheckLabel checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)}>
                  {t("serviceCopy.move.confirm")}
                </CheckLabel>
              )}
            </div>
          )}

          {move.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(move.error, t("common.unknownError"))}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button className="cursor-pointer duration-200" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="cursor-pointer duration-200"
              disabled={!i || blocked || move.isPending || (needsTick && !confirmed)}
            >
              {t("serviceCopy.move.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImpactList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-ink-strong">{title}</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 rounded-control bg-raised px-3 py-2 text-[12.5px]">{children}</ul>
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <p className="m-0 text-ink-strong">{children}</p>;
}
