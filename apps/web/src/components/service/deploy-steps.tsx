// The deploy timeline (Deployments.dc.html): Clone > Build on <node> >
// Ship to <node> > Health check > Switch traffic. Chips for history rows,
// cards with time and detail for the log modal.

import type { deployments } from "@seylo/ops";
import { cn } from "@seylo/ui/lib/utils";
import { IconCheck, IconChevronRight, IconLoader2, IconMinus, IconX } from "@tabler/icons-react";
import { Fragment } from "react";
import { t } from "../../i18n/t";
import { formatDuration } from "./format";

export type Deployment = (typeof deployments.Deployment)["static"];
export type DeploymentStep = (typeof deployments.DeploymentStep)["static"];
type StepStatus = DeploymentStep["status"];

export function stepName(step: DeploymentStep): string {
  const node = step.node?.name;
  switch (step.key) {
    case "clone":
      return t("serviceDeploys.steps.clone");
    case "build":
      return node ? t("serviceDeploys.steps.buildOn", { node }) : t("serviceDeploys.steps.build");
    case "ship":
      return node ? t("serviceDeploys.steps.shipTo", { node }) : t("serviceDeploys.steps.ship");
    case "health":
      return t("serviceDeploys.steps.health");
    case "switch":
      return t("serviceDeploys.steps.switch");
  }
}

const chipTone: Record<StepStatus, string> = {
  ok: "bg-chip-green-bg text-chip-green-fg",
  running: "bg-chip-amber-bg text-chip-amber-fg",
  failed: "bg-chip-red-bg text-chip-red-fg",
  pending: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
};

function StepIcon({ status, size }: { status: StepStatus; size: number }) {
  if (status === "ok") return <IconCheck size={size} stroke={3} className="text-status-ok" aria-hidden="true" />;
  if (status === "running") return <IconLoader2 size={size} stroke={3} className="animate-spin text-status-busy" aria-hidden="true" />;
  if (status === "failed") return <IconX size={size} stroke={3} className="text-status-error" aria-hidden="true" />;
  if (status === "skipped") return <IconMinus size={size} stroke={3} className="text-muted-foreground" aria-hidden="true" />;
  return null;
}

/** A row of step chips with chevrons between them. */
export function StepChips({ steps }: { steps: readonly DeploymentStep[] }) {
  return (
    <ol aria-label={t("serviceDeploys.steps.label")} className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-xs font-medium">
      {steps.map((step, i) => (
        <Fragment key={step.key}>
          {i > 0 && <IconChevronRight size={12} stroke={2.4} className="text-ink-ghost" aria-hidden="true" />}
          <li className={cn("flex items-center gap-[5px] rounded-chip px-2 py-[3px]", chipTone[step.status])}>
            <StepIcon status={step.status} size={12} />
            {stepName(step)}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

const cardTone: Record<StepStatus, { card: string; dot: string; detail: string }> = {
  ok: { card: "bg-raised", dot: "bg-chip-green-bg", detail: "text-ink-strong" },
  running: { card: "bg-raised", dot: "bg-chip-amber-bg", detail: "text-ink-strong" },
  failed: { card: "bg-chip-red-bg/60", dot: "bg-chip-red-bg", detail: "text-chip-red-fg" },
  pending: { card: "bg-raised", dot: "bg-track", detail: "text-muted-foreground" },
  skipped: { card: "bg-raised", dot: "bg-track", detail: "text-muted-foreground" },
};

/** Step cards for the log modal: icon, time, name and the one-line result. */
export function StepCards({ steps }: { steps: readonly DeploymentStep[] }) {
  return (
    <ol aria-label={t("serviceDeploys.steps.label")} className="m-0 flex list-none flex-wrap gap-2 p-0">
      {steps.map((step) => {
        const tone = cardTone[step.status];
        return (
          <li
            key={step.key}
            className={cn("box-border flex min-w-0 flex-[1_1_110px] flex-col gap-1 rounded-[10px] px-3 py-2.5", tone.card)}
          >
            <span className="mb-0.5 flex items-center gap-[7px]">
              <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", tone.dot)}>
                <StepIcon status={step.status} size={11} />
              </span>
              <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
                {step.status === "skipped"
                  ? t("serviceDeploys.steps.skipped")
                  : step.durationMs != null
                    ? formatDuration(step.durationMs)
                    : step.status === "running"
                      ? t("serviceDeploys.steps.running")
                      : ""}
              </span>
            </span>
            <b className="text-[12.5px] font-semibold">{stepName(step)}</b>
            {step.detail && <span className={cn("text-xs leading-[1.4]", tone.detail)}>{step.detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}
