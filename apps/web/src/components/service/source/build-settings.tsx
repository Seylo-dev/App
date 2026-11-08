// How the source is built: Railpack (default), Nixpacks (maintenance mode
// upstream) or a Dockerfile; paths, command overrides and the build node.
// Nodes without "Can build" or docker buildx, or offline, stay in the list,
// disabled, so the reason a node is not offered is visible.

import { builds, type OpInput, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { FieldSkeleton, LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

type Settings = OpOutput<typeof builds.getSettings>;
type Builder = Settings["settings"]["builder"];
type SettingsInput = OpInput<typeof builds.updateSettings>;
const auto = "__auto__";

/** Why a node cannot be picked as the build node (builds.updateSettings refuses it); null when it can. */
export function nodeUnavailable(node: Settings["nodes"][number]) {
  if (!node.canBuild) return "serviceSource.build.cantBuild" as const;
  if (node.hasBuildx === false) return "serviceSource.build.noBuildx" as const;
  if (!node.online) return "serviceSource.build.offline" as const;
  return null;
}

/**
 * What Save sends. The build node goes only when it changed: the panel checks
 * a new one, and a node that lost buildx (or Can build) since it was picked
 * must not block saving the other fields.
 */
export function settingsInput(
  serviceId: string,
  savedNodeId: string | null,
  buildNodeId: string | null,
  fields: Required<
    Pick<SettingsInput, "builder" | "contextPath" | "dockerfilePath" | "installCommand" | "buildCommand" | "startCommand" | "targetStage">
  >,
  dockerfileOnly: boolean,
): SettingsInput {
  const { targetStage, ...source } = fields;
  return {
    serviceId,
    ...(dockerfileOnly ? {} : source),
    targetStage,
    ...(buildNodeId !== savedNodeId ? { buildNodeId } : {}),
  };
}

export function BuildSettingsCard({ service, dockerfileOnly = false }: { service: ServiceDetail; dockerfileOnly?: boolean }) {
  const settings = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  return (
    <SectionCard title={t("serviceSource.build.title")} description={t("serviceSource.build.description")}>
      {settings.isPending ? (
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
          {!dockerfileOnly && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[62px] bg-raised" />
              ))}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <FieldSkeleton hint />
            <FieldSkeleton hint />
          </div>
        </LoadingRegion>
      ) : settings.isError ? (
        <OpErrorNote error={settings.error} />
      ) : (
        <BuildForm key={JSON.stringify(settings.data.settings)} service={service} data={settings.data} dockerfileOnly={dockerfileOnly} />
      )}
    </SectionCard>
  );
}

function BuildForm({ service, data, dockerfileOnly }: { service: ServiceDetail; data: Settings; dockerfileOnly: boolean }) {
  const s = data.settings;
  const [builder, setBuilder] = useState<Builder>(dockerfileOnly ? "dockerfile" : s.builder);
  const [contextPath, setContextPath] = useState(s.contextPath);
  const [dockerfilePath, setDockerfilePath] = useState(s.dockerfilePath || "Dockerfile");
  const [targetStage, setTargetStage] = useState(s.targetStage);
  const [installCommand, setInstall] = useState(s.installCommand);
  const [buildCommand, setBuild] = useState(s.buildCommand);
  const [startCommand, setStart] = useState(s.startCommand);
  const [buildNodeId, setBuildNodeId] = useState<string | null>(s.buildNodeId);
  const invalidate = useInvalidate();
  const save = useOpMutation(builds.updateSettings, {
    onSuccess: () => {
      invalidate(builds.getSettings);
      toast.success(t("service.saved"));
    },
  });

  const submit = () =>
    save.mutate(
      settingsInput(
        service.id,
        s.buildNodeId,
        buildNodeId,
        { builder, contextPath, dockerfilePath, installCommand, buildCommand, startCommand, targetStage },
        dockerfileOnly,
      ),
    );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!dockerfileOnly && (
        <RadioGroup
          value={builder}
          onValueChange={(v) => setBuilder(v as Builder)}
          aria-label={t("serviceSource.build.builder")}
          className="grid-cols-[repeat(auto-fit,minmax(200px,1fr))]"
        >
          {(["railpack", "nixpacks", "dockerfile"] as const).map((b) => (
            <RadioCard
              key={b}
              value={b}
              title={t(`serviceSource.builders.${b}.name`)}
              description={t(`serviceSource.builders.${b}.hint`)}
            />
          ))}
        </RadioGroup>
      )}
      {builder === "nixpacks" && (
        <p role="note" className="text-xs text-chip-amber-fg">
          {t("serviceSource.build.envNixpacks")}
        </p>
      )}
      {builder === "dockerfile" && <p className="text-xs text-muted-foreground">{t("serviceSource.build.envSecrets")}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {!dockerfileOnly && (
          <Field label={t("serviceSource.rootDir")} htmlFor="b-context" hint={t("serviceSource.rootDirHint")}>
            <Input
              id="b-context"
              className="font-mono"
              value={contextPath}
              onChange={(e) => setContextPath(e.target.value)}
              placeholder="."
            />
          </Field>
        )}
        {builder === "dockerfile" && !dockerfileOnly && (
          <Field label={t("serviceSource.build.dockerfilePath")} htmlFor="b-dockerfile">
            <Input id="b-dockerfile" className="font-mono" value={dockerfilePath} onChange={(e) => setDockerfilePath(e.target.value)} />
          </Field>
        )}
        {builder === "dockerfile" && (
          <Field label={t("serviceSource.build.targetStage")} htmlFor="b-stage" hint={t("serviceSource.build.targetStageHint")}>
            <Input id="b-stage" className="font-mono" value={targetStage} onChange={(e) => setTargetStage(e.target.value)} />
          </Field>
        )}
        {builder !== "dockerfile" && (
          <>
            <Field label={t("serviceSource.build.installCommand")} htmlFor="b-install" hint={t("serviceSource.build.detectedHint")}>
              <Input id="b-install" className="font-mono" value={installCommand} onChange={(e) => setInstall(e.target.value)} />
            </Field>
            <Field label={t("serviceSource.build.buildCommand")} htmlFor="b-build" hint={t("serviceSource.build.detectedHint")}>
              <Input id="b-build" className="font-mono" value={buildCommand} onChange={(e) => setBuild(e.target.value)} />
            </Field>
            <Field label={t("serviceSource.build.startCommand")} htmlFor="b-start" hint={t("serviceSource.build.detectedHint")}>
              <Input id="b-start" className="font-mono" value={startCommand} onChange={(e) => setStart(e.target.value)} />
            </Field>
          </>
        )}
        <Field label={t("serviceSource.build.node")} hint={t("serviceSource.build.nodeHint")}>
          <Select value={buildNodeId ?? auto} onValueChange={(v) => setBuildNodeId(v === auto ? null : v)}>
            <SelectTrigger aria-label={t("serviceSource.build.node")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={auto}>{t("service.automatic")}</SelectItem>
              {data.nodes.map((n) => {
                const why = nodeUnavailable(n);
                return (
                  <SelectItem key={n.id} value={n.id} disabled={why !== null}>
                    {n.name}
                    {why ? ` · ${t(why)}` : n.queued > 0 ? ` · ${t("serviceSource.build.queued", { count: n.queued })}` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? t("service.saving") : t("service.save")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("serviceSource.build.nextDeploy")}</span>
        <MutationError error={save.error} />
      </div>
    </form>
  );
}
