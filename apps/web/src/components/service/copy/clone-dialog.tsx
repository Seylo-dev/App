// "Clone" from the service menu: pick the project, node and name, choose
// whether the volumes start empty or get a copy of the data, add an
// automatic domain, and for a repository source whether the clone deploys
// on push (the source's setting to start with). services.clonePreview says
// what comes along for this person (their permissions decide whether the
// environment and the data can be copied); services.clone creates the
// stopped copy.

import { projects, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconCheck } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { deploysOnPush } from "../../../lib/service-display";
import { NodePicker, ProjectPicker } from "../../pickers";
import { CheckLabel, Field, ToggleRow } from "../field";
import { useInvalidate } from "../invalidate";
import { OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

type Preview = (typeof services.clonePreview.output)["static"];
type Blocked = NonNullable<Preview["data"]["blockedBy"]>;

function blockedText(reason: Blocked): string | null {
  switch (reason) {
    case "noVolumes":
      return null;
    case "databaseLogins":
      return t("serviceCopy.clone.blocked.databaseLogins");
    case "files":
      return t("serviceCopy.clone.blocked.files");
    case "offline":
      return t("serviceCopy.clone.blocked.offline");
    case "agentTooOld":
      return t("serviceCopy.clone.blocked.agentTooOld");
    case "control":
      return t("serviceCopy.clone.blocked.control");
  }
}

/** What the Deploy on push switch does for this clone, under the switch. */
function pushNote(source: ServiceDetail["sourceConfig"], sourcePush: boolean, clonePush: boolean, name: string): string {
  const branch = "branch" in source ? source.branch : "";
  if (!clonePush) return t("serviceCopy.clone.pushOff", { branch });
  if (source.type === "git") return t("serviceCopy.clone.pushGit");
  return t(sourcePush ? "serviceCopy.clone.pushBoth" : "serviceCopy.clone.pushCloneOnly", { branch, name });
}

export function CloneDialog({
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
  const [projectId, setProjectId] = useState(service.projectId);
  const [nodeId, setNodeId] = useState(service.placements[0]?.nodeId ?? "");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [data, setData] = useState<"empty" | "copy">("empty");
  const [stopSource, setStopSource] = useState(true);
  const [autoDomain, setAutoDomain] = useState(true);
  // Only repository sources have the switch (null for the others); the clone starts with the source's setting.
  const sourcePush = deploysOnPush(service.sourceConfig);
  const [deployOnPush, setDeployOnPush] = useState(sourcePush ?? false);
  const preview = useOp(services.clonePreview, { serviceId: service.id, projectId, nodeId }, { enabled: open && !!nodeId, retry: retryOp });
  const projectList = useOp(projects.list, {}, { enabled: open });
  const projectName = projectList.data?.projects.find((p) => p.id === projectId)?.name ?? "";

  // The suggested name follows the target project until the person types one.
  useEffect(() => {
    if (!nameEdited && preview.data) setName(preview.data.name);
  }, [nameEdited, preview.data]);
  useEffect(() => {
    if (preview.data && !preview.data.data.available) setData("empty");
  }, [preview.data]);

  const clone = useOpMutation(services.clone, {
    onSuccess: (res) => {
      onOpenChange(false);
      invalidate(services.list);
      toast.success(t("serviceCopy.clone.created", { name: res.service.name }), {
        action: {
          label: t("serviceCopy.clone.view"),
          onClick: () =>
            void navigate({ to: "/p/$projectId/s/$serviceId", params: { projectId: res.service.projectId, serviceId: res.service.id } }),
        },
      });
    },
  });

  const p = preview.data;
  // Variables that named the source itself now name the clone: shown apart from the warnings.
  const renamed = p?.references.filter((r) => r.effect === "renamed") ?? [];
  const changed = p?.references.filter((r) => r.effect !== "renamed") ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!p) return;
    clone.mutate({
      serviceId: service.id,
      projectId,
      nodeId,
      name: name.trim() || undefined,
      data: p.volumes.length > 0 ? data : undefined,
      stopSource: data === "copy" && !p.data.alwaysStops ? stopSource : undefined,
      autoDomain: p.autoDomain !== null ? autoDomain : undefined,
      deployOnPush: sourcePush !== null ? deployOnPush : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[8%] max-h-[84vh] max-w-xl overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label={t("serviceCopy.clone.title", { name: service.name })}>
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceCopy.clone.title", { name: service.name })}</DialogTitle>
            <DialogDescription>{t("serviceCopy.clone.description")}</DialogDescription>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("serviceCopy.clone.project")} htmlFor="clone-project">
              <ProjectPicker id="clone-project" value={projectId} onChange={setProjectId} />
            </Field>
            <Field label={t("serviceCopy.clone.node")} htmlFor="clone-node">
              <NodePicker id="clone-node" value={nodeId} onChange={setNodeId} />
            </Field>
          </div>
          <Field label={t("serviceCopy.clone.name")} htmlFor="clone-name">
            <Input
              id="clone-name"
              value={name}
              maxLength={40}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
            />
          </Field>

          {preview.isError ? (
            <OpErrorNote error={preview.error} />
          ) : !p ? (
            <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5 text-[13px]">
                <SkeletonText className="w-28 text-xs" />
                <span className="flex items-center gap-2">
                  <Skeleton className="size-3.5 shrink-0 rounded-full" />
                  <SkeletonText className="w-48" />
                </span>
                <span className="flex items-center gap-2">
                  <Skeleton className="size-3.5 shrink-0 rounded-full" />
                  <SkeletonText className="w-40" />
                </span>
              </div>
              <SkeletonText className="w-3/4 text-[12.5px]" />
            </LoadingRegion>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-xs font-medium text-muted-foreground">{t("serviceCopy.clone.copied")}</span>
                <Copied>{t("serviceCopy.clone.settings")}</Copied>
                {p.env === "copied" && <Copied>{t("serviceCopy.clone.envCopied")}</Copied>}
                {p.env === "hidden" && (
                  <Alert tone="warning" className="py-2">
                    {t("serviceCopy.clone.envHidden")}
                  </Alert>
                )}
                {p.env === "noWrite" && (
                  <Alert tone="warning" className="py-2">
                    {t("serviceCopy.clone.envNoWrite", { project: projectName })}
                  </Alert>
                )}
              </div>

              {p.volumes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">{t("serviceCopy.clone.data")}</span>
                  <RadioGroup
                    value={data}
                    onValueChange={(v) => setData(v as "empty" | "copy")}
                    className="grid gap-2 sm:grid-cols-2"
                    aria-label={t("serviceCopy.clone.data")}
                  >
                    <RadioCard value="empty" title={t("serviceCopy.clone.empty")} description={t("serviceCopy.clone.emptyDescription")} />
                    <RadioCard
                      value="copy"
                      disabled={!p.data.available}
                      title={t("serviceCopy.clone.copy")}
                      description={
                        p.data.blockedBy
                          ? (blockedText(p.data.blockedBy) ?? undefined)
                          : t("serviceCopy.clone.copyDescription", { volumes: p.volumes.map((v) => v.name).join(", ") })
                      }
                    />
                  </RadioGroup>
                  {data === "copy" &&
                    (p.data.alwaysStops ? (
                      <p className="m-0 text-[12.5px] text-muted-foreground">
                        {t("serviceCopy.clone.alwaysStops", { name: service.name })}
                      </p>
                    ) : (
                      <CheckLabel checked={stopSource} onCheckedChange={(v) => setStopSource(v === true)}>
                        {t("serviceCopy.clone.stopSource", { name: service.name })}
                      </CheckLabel>
                    ))}
                </div>
              )}

              {p.autoDomain && (
                <CheckLabel checked={autoDomain} onCheckedChange={(v) => setAutoDomain(v === true)}>
                  {t("serviceCopy.clone.autoDomain", { host: p.autoDomain })}
                  {p.middlewares && <span className="text-muted-foreground"> {t("serviceCopy.clone.autoDomainRules")}</span>}
                </CheckLabel>
              )}

              {sourcePush !== null && (
                <ToggleRow
                  title={t("serviceCopy.clone.deployOnPush")}
                  description={pushNote(service.sourceConfig, sourcePush, deployOnPush, service.name)}
                  control={
                    <Switch checked={deployOnPush} onCheckedChange={setDeployOnPush} aria-label={t("serviceCopy.clone.deployOnPush")} />
                  }
                />
              )}

              {renamed.length > 0 && (
                <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
                  <span>{t("serviceCopy.clone.renamed", { name: service.name })}</span>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {renamed.map((r) => (
                      <li key={`${r.key}:${r.target}`}>
                        <span className="font-mono">{r.key}</span> <span className="font-mono">{r.target}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {changed.length > 0 && (
                <Alert tone="warning" className="py-2">
                  <div className="flex flex-col gap-1">
                    <span>{t("serviceCopy.clone.references", { project: projectName })}</span>
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {changed.map((r) => (
                        <li key={`${r.key}:${r.target}`}>
                          <span className="font-mono">{r.key}</span> <span className="font-mono">{r.target}</span>{" "}
                          {r.effect === "unresolved"
                            ? t("serviceCopy.clone.unresolved")
                            : t("serviceCopy.clone.retargeted", { project: projectName })}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Alert>
              )}

              <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceCopy.clone.notCopied")}</p>
            </>
          )}

          {clone.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(clone.error, t("common.unknownError"))}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!p || clone.isPending || name.trim() === ""}>
              {t("serviceCopy.clone.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Copied({ children }: { children: string }) {
  return (
    <span className="flex items-center gap-2 text-ink-strong">
      <IconCheck size={14} stroke={2.2} className="text-chip-green-fg" aria-hidden="true" />
      {children}
    </span>
  );
}
