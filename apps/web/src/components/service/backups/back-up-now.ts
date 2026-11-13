// "Back up now" at the top of a service's Backups tab and on a database's
// Connection tab: every enabled schedule at once (backups.runAll), each
// counted toward its own Keep newest; schedules that are off, or still
// backing up, are skipped, and the toast names any that could not start.
// A database with no schedule gets a one-off dump to the first
// destination. A schedule's own menu still backs up just that one
// (backups.runNow with its id).

import { backups, OpError, type OpOutput } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { useInvalidate } from "../invalidate";
import { isNotBuilt } from "../op-state";
import { isDatabaseKind } from "../status";
import type { ServiceDetail } from "../use-service";

type Policy = OpOutput<typeof backups.listPolicies>["policies"][number];
type Choice = OpOutput<typeof backups.listDestinations>["choices"][number];
export type RunAllResult = OpOutput<typeof backups.runAll>;

/**
 * What the toast says after Back up now for every schedule. A schedule that
 * could not start is counted whether the node refused its run or the panel
 * refused it before storing one (skipped with reason error).
 */
export function runAllToast(result: RunAllResult): { tone: "success" | "info" | "warning"; text: string } {
  const failed = result.runs.filter((r) => r.status === "failed");
  const started = result.runs.length - failed.length;
  const running = result.skipped.filter((s) => s.reason === "running").length;
  const errors = [...failed.map((r) => r.error ?? ""), ...result.skipped.filter((s) => s.reason === "error").map((s) => s.error ?? "")];
  if (started === 0 && errors.length === 0) {
    return { tone: "info", text: running > 0 ? t("serviceBackups.allRunning") : t("serviceBackups.allOff") };
  }
  const parts = started > 0 ? [t("serviceBackups.startedMany", { count: started })] : [];
  if (running > 0) parts.push(t("serviceBackups.alsoRunning", { count: running }));
  if (errors.length > 0) parts.push(t("serviceBackups.notStarted", { count: errors.length, error: errors[0] ?? "" }));
  return { tone: errors.length > 0 ? "warning" : "success", text: parts.join(" ") };
}

/** Which Back up now applies: every schedule, a one-off dump of a database without one, or none (nothing to back up to yet). */
export function backUpNowPlan(
  service: Pick<ServiceDetail, "kind">,
  policies: readonly Policy[] | undefined,
  choices: readonly Choice[],
): { kind: "schedules" } | { kind: "oneOff"; destinationId: string } | null {
  if (!policies) return null;
  if (policies.length > 0) return { kind: "schedules" };
  const first = choices[0];
  return first && isDatabaseKind(service.kind) ? { kind: "oneOff", destinationId: first.id } : null;
}

/**
 * What Back up now on one schedule's menu says when the panel refuses it.
 * Since 0.2.16 a schedule whose backup still runs is refused (CONFLICT,
 * reason running), as Back up now for the whole service and the scheduler
 * skip it: that is news, not a failure.
 */
export function runNowRefusal(error: unknown): { tone: "info" | "error"; text: string } {
  if (error instanceof OpError && error.details?.reason === "running") return { tone: "info", text: t("serviceBackups.scheduleRunning") };
  return { tone: "error", text: isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")) };
}

export const failRunNow = (error: unknown) => {
  const shown = runNowRefusal(error);
  toast[shown.tone](shown.text);
};

const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function useBackUpNow(service: ServiceDetail, policies: readonly Policy[] | undefined, choices: readonly Choice[]) {
  const invalidate = useInvalidate();
  const all = useOpMutation(backups.runAll, {
    onSuccess: (result) => {
      invalidate(backups.listRuns, backups.listPolicies);
      const shown = runAllToast(result);
      toast[shown.tone](shown.text);
    },
    onError: fail,
  });
  const once = useOpMutation(backups.runNow, {
    onSuccess: () => {
      invalidate(backups.listRuns, backups.listPolicies);
      toast.success(t("serviceBackups.started"));
    },
    onError: fail,
  });
  const plan = backUpNowPlan(service, policies, choices);
  const pending = all.isPending || once.isPending;
  const run = () => {
    if (plan?.kind === "schedules") all.mutate({ serviceId: service.id });
    else if (plan?.kind === "oneOff") once.mutate({ serviceId: service.id, target: "database", destinationId: plan.destinationId });
  };
  return { run, disabled: pending || plan === null };
}
