// The Environment tab (Environment.dc.html): the .env editor with live
// diagnostics, the References panel, save with Cmd/Ctrl+S, and after a save
// that running instances do not have yet, a prompt to deploy (a restart
// keeps the values of the last deploy). The panel is never taller than the
// editor card: its groups scroll inside it.

import { type AnalyzeContext, analyzeEnv, type Diagnostic } from "@seylo/env-analyzer";
import { deployments, env, OpError, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpClient, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Kbd } from "@seylo/ui/components/kbd";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconAlertCircle, IconBraces, IconEye, IconEyeOff, IconStack2 } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { useActiveDeploy } from "../active-deploy";
import type { EnvEditorHandle } from "../editor/env-editor";
import { EnvEditor } from "../editor/env-editor";
import { fixTitle, problemSummary } from "../editor/env-model";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, OpErrorNote, retryOp } from "../op-state";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";
import { buildsFromRepository, ReferencesPanel, referencesColumn } from "./references-panel";
import { SharedVariablesSheet } from "./shared-sheet";

const emptyContext = (service: ServiceDetail): AnalyzeContext => ({
  self: { serviceId: service.id, name: service.name, nodes: service.placements.map((p) => ({ id: p.nodeId, name: p.nodeName })) },
  targets: [],
});

export function EnvironmentPage({ service }: { service: ServiceDetail }) {
  const saved = useOp(env.get, { serviceId: service.id }, { retry: retryOp, staleTime: Number.POSITIVE_INFINITY });
  if (saved.isPending) return <EnvironmentSkeleton />;
  if (saved.isError) return <OpErrorNote error={saved.error} />;
  return <EnvironmentEditor key={service.id} service={service} initial={saved.data} />;
}

function EnvironmentEditor({ service, initial }: { service: ServiceDetail; initial: OpOutput<typeof env.get> }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const client = useOpClient();
  const references = useOp(env.references, { serviceId: service.id }, { retry: retryOp });
  const [text, setText] = useState(initial.text);
  const [base, setBase] = useState({ text: initial.text, updatedAt: initial.updatedAt });
  const [showRefs, setShowRefs] = useState(true);
  const [reveal, setReveal] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [sharedOpen, setSharedOpen] = useState(false);
  const handle = useRef<EnvEditorHandle | null>(null);
  const editorCard = useRef<HTMLElement | null>(null);
  const editorHeight = useHeight(editorCard);

  const context = references.data ?? null;
  const analysis = useMemo(() => analyzeEnv(text, context ?? emptyContext(service)), [text, context, service]);
  const problems = analysis.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
  const dirty = text !== base.text;

  const fail = (error: unknown) =>
    toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));
  const save = useOpMutation(env.set, {
    // The text that was sent, not the editor's text now: TanStack Query runs the
    // newest render's onSuccess, and anything typed during the save is still unsaved.
    onSuccess: (res, sent) => {
      setBase({ text: sent.text, updatedAt: res.updatedAt });
      setRestartNeeded(res.restartNeeded);
      setConflict(false);
      invalidate(env.references, env.analyze);
      toast.success(t("service.saved"));
    },
    onError: (error) => {
      if (error instanceof OpError && error.code === "CONFLICT") setConflict(true);
      else fail(error);
    },
  });
  // One deploy at a time: the Deploy below waits for one in progress.
  const deploying = useActiveDeploy(service.id) !== null;
  const deploy = useOpMutation(deployments.deploy, {
    onSuccess: () => {
      setRestartNeeded(false);
      invalidate(deployments.list);
      toast.success(t("service.header.deployStarted"));
    },
    onError: fail,
  });
  const move = useOpMutation(services.move, {
    onSuccess: () => {
      toast.success(t("serviceEnv.moveStarted"));
      void navigate({ to: "/p/$projectId/s/$serviceId/deployments", params: { projectId: service.projectId, serviceId: service.id } });
    },
    onError: fail,
  });

  const onSave = () => {
    if (save.isPending) return;
    const syntax = analysis.parsed.problems.length;
    if (syntax > 0) return void toast.error(t("serviceEnv.syntaxBlocksSave", { count: syntax }));
    save.mutate({ serviceId: service.id, text, expectedUpdatedAt: base.updatedAt });
  };

  const reload = async () => {
    try {
      const fresh = await client.call(env.get, { serviceId: service.id });
      setText(fresh.text);
      setBase({ text: fresh.text, updatedAt: fresh.updatedAt });
      setConflict(false);
      invalidate(env.references);
    } catch (error) {
      fail(error);
    }
  };

  const runFix = (d: Diagnostic, fixIndex: number) => {
    const fix = d.fixes[fixIndex];
    if (!fix) return;
    if (fix.kind === "edit") handle.current?.applyEdits(fix.edits.map((e) => ({ start: e.range.start, end: e.range.end, text: e.text })));
    else if (fix.kind === "moveService") move.mutate({ serviceId: service.id, toNodeId: fix.nodeId });
    else {
      const target = context?.targets.find((x) => x.serviceId === fix.serviceId);
      void navigate({
        to: isDatabaseKind(target?.serviceKind ?? "") ? "/p/$projectId/s/$serviceId/connection" : "/p/$projectId/s/$serviceId/domains",
        params: { projectId: service.projectId, serviceId: fix.serviceId },
      });
    }
  };

  const summary = problemSummary(problems).slice(0, 4);

  return (
    <div className="flex flex-col gap-4">
      {conflict && (
        <Callout
          tone="warning"
          title={t("serviceEnv.conflictTitle")}
          action={
            <Button size="sm" onClick={() => void reload()}>
              {t("serviceEnv.loadTheirs")}
            </Button>
          }
        >
          {t("serviceEnv.conflictBody")}
        </Callout>
      )}
      {restartNeeded && !dirty && (
        <Callout
          tone="info"
          title={t("serviceEnv.appliedTitle")}
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={() => deploy.mutate({ serviceId: service.id })}
              disabled={deploy.isPending || deploying}
              title={deploying ? t("service.header.deployBusyHint") : undefined}
            >
              {t(deploying ? "service.header.deployBusy" : "service.header.deploy")}
            </Button>
          }
        >
          {t("serviceEnv.appliedBody")}
        </Callout>
      )}
      {/* A size container: the References column takes its width from this row (referencesColumn). */}
      <div className="@container flex flex-wrap items-start gap-4">
        <section
          ref={editorCard}
          aria-label={t("serviceEnv.title")}
          className="min-w-0 flex-[999_1_520px] rounded-card bg-card shadow-card"
        >
          <div className="flex flex-wrap items-center gap-2.5 border-b border-divider px-4 py-3.5">
            <h2 className="m-0 text-[15px] font-semibold">{t("serviceEnv.title")}</h2>
            {/* The only way into the project's shared variables, so it looks like the button it is. */}
            <Button size="sm" className="h-[34px] bg-muted shadow-none" onClick={() => setSharedOpen(true)}>
              <IconStack2 size={14} />
              {t("serviceEnv.sharedEdit")}
              {initial.sharedCount > 0 && (
                <span className="rounded-chip bg-track px-1.5 text-[11.5px] tabular-nums text-ink-strong">{initial.sharedCount}</span>
              )}
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {problems.length > 0 && (
                <span className="flex items-center gap-1.5 rounded-chip bg-chip-red-bg px-2 py-[3px] text-xs font-medium whitespace-nowrap text-chip-red-fg">
                  <IconAlertCircle size={13} stroke={2.2} aria-hidden="true" />
                  {t("serviceEnv.problems", { count: problems.length })}
                </span>
              )}
              <Button
                size="sm"
                className="h-[34px] bg-transparent shadow-none"
                aria-pressed={reveal}
                onClick={() => setReveal((v) => !v)}
                aria-label={reveal ? t("serviceEnv.hideValues") : t("serviceEnv.showValues")}
              >
                {reveal ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </Button>
              <Button
                size="sm"
                aria-pressed={showRefs}
                onClick={() => setShowRefs((v) => !v)}
                className={cn("h-[34px] shadow-none", showRefs ? "bg-chip-blue-bg text-chip-blue-fg hover:bg-chip-blue-bg" : "bg-muted")}
              >
                <IconBraces size={14} />
                {t("serviceEnv.refs.title")}
              </Button>
              <Button variant="primary" size="sm" className="h-[34px]" onClick={onSave} disabled={!dirty || save.isPending}>
                {save.isPending ? t("service.saving") : t("service.save")}
                <Kbd className="bg-foreground/20 text-[11px] text-primary-foreground">⌘S</Kbd>
              </Button>
            </div>
          </div>
          <EnvEditor
            text={text}
            onChange={setText}
            analysis={analysis}
            context={context}
            selfName={service.name}
            reveal={reveal}
            onSave={onSave}
            onCursor={(line, column) => setCursor({ line, column })}
            onHandle={(h) => {
              handle.current = h;
            }}
          />
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-b-card border-t border-divider bg-raised px-4 py-2.5 text-xs text-muted-foreground">
            {summary.map((p) => (
              <span key={`${p.line}:${p.diagnostic.range.start}:${p.diagnostic.code}`} className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handle.current?.revealLine(p.line)}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-xs",
                    p.severity === "error" ? "text-chip-red-fg" : "text-chip-amber-fg",
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", p.severity === "error" ? "bg-status-error" : "bg-status-busy")} />
                  {t("serviceEnv.lineProblem", { line: p.line, text: p.text })}
                </button>
                {p.diagnostic.fixes.map((fix, i) => (
                  <button
                    key={fix.title}
                    type="button"
                    onClick={() => runFix(p.diagnostic, i)}
                    className="cursor-pointer rounded-chip border-0 bg-button px-1.5 py-0.5 text-[11.5px] font-medium text-link shadow-button transition-interactive hover:bg-button-hover"
                  >
                    {fixTitle(fix, service.name, p.diagnostic)}
                  </button>
                ))}
              </span>
            ))}
            <span className="ml-auto">
              {t("serviceEnv.footerHint")} · {t("serviceEnv.cursor", { line: cursor.line, column: cursor.column })}
            </span>
          </div>
        </section>
        {showRefs &&
          (context ? (
            <ReferencesPanel
              context={context}
              serviceKind={service.kind}
              projectId={service.projectId}
              reveal={reveal}
              builtFromRepository={buildsFromRepository(service.sourceConfig)}
              maxHeight={editorHeight}
              onInsert={(v) => handle.current?.insert(v)}
            />
          ) : references.isError ? (
            <div className={referencesColumn}>
              <OpErrorNote error={references.error} />
            </div>
          ) : (
            <ReferencesSkeleton />
          ))}
      </div>
      <SharedVariablesSheet projectId={service.projectId} open={sharedOpen} onOpenChange={setSharedOpen} />
    </div>
  );
}

/**
 * The element's height, measured before the first paint and again as it
 * resizes (the problem list in its footer wraps). Undefined until measured
 * and where nothing measures (static rendering).
 */
function useHeight(ref: RefObject<HTMLElement | null>): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const next = Math.round(el.offsetHeight);
      setHeight((current) => (current === next ? current : next));
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/** The editor card (title bar, 420px of lines, status bar) and the references panel while the variables load. */
export function EnvironmentSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="@container flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-[999_1_520px] rounded-card bg-card shadow-card">
        <div className="flex items-center gap-2.5 border-b border-divider px-4 py-3.5">
          <SkeletonText className="w-24 text-[15px]" />
          <SkeletonText className="w-40 text-[12.5px]" />
          <div className="ml-auto flex gap-1.5">
            <ButtonSkeleton size="icon" className="size-8" />
            <ButtonSkeleton size="sm" className="w-[104px]" />
            <ButtonSkeleton size="sm" className="w-[74px]" />
          </div>
        </div>
        <div className="flex h-[420px] flex-col gap-[9px] px-4 py-3">
          {["w-40", "w-52", "w-44", "w-96", "w-60", "w-72", "w-80", "w-64", "w-48", "w-56"].map((width) => (
            <div key={width} className="flex items-center gap-4">
              <Skeleton className="h-3 w-3 shrink-0 rounded-chip" />
              <Skeleton className={`h-3 max-w-full rounded-chip ${width}`} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3.5 rounded-b-card border-t border-divider bg-raised px-4 py-2.5 text-xs">
          <SkeletonText className="w-48" />
          <SkeletonText className="ml-auto w-24" />
        </div>
      </div>
      <ReferencesSkeleton />
    </LoadingRegion>
  );
}

/** The references panel while the project's services load. */
function ReferencesSkeleton() {
  return (
    <div className={cn(referencesColumn, "flex flex-col rounded-card bg-card shadow-card")}>
      <div className="flex flex-col gap-1 border-b border-divider px-[18px] pt-4 pb-3">
        <SkeletonText className="w-24 text-[15px]" />
        <SkeletonText className="w-full text-[12.5px]" />
        <SkeletonText className="w-40 text-[12.5px]" />
      </div>
      <div className="flex flex-col gap-4 px-[18px] pt-3 pb-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-[22px] w-8 rounded-chip" />
              <SkeletonText className="w-20 text-[13px]" />
              <SkeletonText className="w-24 text-xs" />
            </div>
            <div className="flex gap-1.5">
              <Skeleton className="h-[22px] w-[92px] rounded-chip" />
              <Skeleton className="h-[22px] w-24 rounded-chip" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
