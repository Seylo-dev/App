// How the source is built: Railpack (default), Nixpacks (maintenance mode
// upstream) or a Dockerfile; paths, command overrides and the build node.
// Nodes without "Can build" stay in the list, disabled, so the reason a
// node is not offered is visible.

import { builds, type OpOutput } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";

type Settings = OpOutput<typeof builds.getSettings>;
type Builder = Settings["settings"]["builder"];
const auto = "__auto__";

export function BuildSettingsCard({ service, dockerfileOnly = false }: { service: ServiceDetail; dockerfileOnly?: boolean }) {
  const settings = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  return (
    <SectionCard title={t("serviceSource.build.title")} description={t("serviceSource.build.description")}>
      {settings.isPending ? (
        <Skeleton className="h-40 w-full" />
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
    save.mutate({
      serviceId: service.id,
      ...(dockerfileOnly ? {} : { builder, contextPath, dockerfilePath, installCommand, buildCommand, startCommand }),
      targetStage,
      buildNodeId,
    });

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
              {data.nodes.map((n) => (
                <SelectItem key={n.id} value={n.id} disabled={!n.canBuild || !n.online}>
                  {n.name}
                  {!n.canBuild
                    ? ` · ${t("serviceSource.build.cantBuild")}`
                    : !n.online
                      ? ` · ${t("serviceSource.build.offline")}`
                      : n.queued > 0
                        ? ` · ${t("serviceSource.build.queued", { count: n.queued })}`
                        : ""}
                </SelectItem>
              ))}
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
