// What a failed deploy shows besides its error (0.2.16): the new
// container's last output in a block of its own, collapsed (the app's
// stdout and stderr, never mixed into the deploy's step log or the red
// error), and "Use port 6000" when the app listened on another port than
// the service's (Deployment.portHint, services.usePort). In the deploy log
// dialog and under the deploy in the Deployments history.

import { deployments, services } from "@seylo/ops";
import { useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronRight, IconPlugConnected } from "@tabler/icons-react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import type { Deployment } from "./deploy-steps";
import { useInvalidate } from "./invalidate";
import { isNotBuilt } from "./op-state";

/** At most this many Use port buttons (an app rarely listens on more than one other port). */
const maxPortButtons = 3;

/**
 * The ports Use port offers: the ones the app listens on, on all addresses,
 * when the service can switch and still has the port the deploy checked
 * (servicePort: its first TCP port now; undefined when the caller does not
 * know it). Once switched, the failed deploy offers it no more.
 */
export function usePortChoices(d: Pick<Deployment, "status" | "portHint">, servicePort?: number | null): number[] {
  if (d.status !== "failed" || !d.portHint?.canUsePort) return [];
  if (servicePort !== undefined && servicePort !== d.portHint.port) return [];
  return d.portHint.listening.slice(0, maxPortButtons);
}

/** The service's first TCP port, the one its default health check dials; null without one. */
export function firstTcpPort(service: { ports: readonly { containerPort: number; protocol: string }[] }): number | null {
  return service.ports.find((p) => p.protocol !== "udp")?.containerPort ?? null;
}

export function LastOutput({ d, className }: { d: Pick<Deployment, "lastOutput">; className?: string }) {
  const output = d.lastOutput;
  if (!output || output.lines.length === 0) return null;
  return (
    <details className={cn("group min-w-0 rounded-control bg-raised", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-control px-3 py-2 text-[12.5px] text-muted-foreground transition-colors duration-200 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <IconChevronRight size={14} stroke={2} className="shrink-0 transition-transform duration-200 group-open:rotate-90" />
        <span className="font-medium">{t("serviceDeploys.lastOutput.title")}</span>
        <span>{t("serviceDeploys.lastOutput.on", { node: output.node.name })}</span>
        <span className="ml-auto text-xs">{t("serviceDeploys.lastOutput.lines", { count: output.lines.length })}</span>
      </summary>
      <CodeBlock code={output.lines.join("\n")} maxHeight={260} className="rounded-t-none bg-raised text-muted-foreground" />
    </details>
  );
}

export function UsePortButtons({
  serviceId,
  d,
  servicePort,
}: {
  serviceId: string;
  d: Pick<Deployment, "status" | "portHint">;
  /** The service's first TCP port now, when known. */
  servicePort?: number | null;
}) {
  const invalidate = useInvalidate();
  const choices = usePortChoices(d, servicePort);
  const use = useOpMutation(services.usePort, {
    onSuccess: (result, input) => {
      invalidate(deployments.list, services.get);
      toast.success(
        result.domainsMove === "rollout"
          ? t("serviceDeploys.usePort.startedLater", { port: input.port })
          : t("serviceDeploys.usePort.started", { port: input.port }),
      );
    },
    onError: (error) => toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed"))),
  });
  const hint = d.portHint;
  if (!hint || choices.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-2">
      {choices.map((port) => (
        <Button
          key={port}
          size="sm"
          variant="primary"
          className="h-8"
          disabled={use.isPending}
          title={t("serviceDeploys.usePort.title", { port, from: hint.port })}
          onClick={() => use.mutate({ serviceId, port, fromPort: hint.port })}
        >
          <IconPlugConnected size={14} stroke={2} />
          {t("serviceDeploys.usePort.button", { port })}
        </Button>
      ))}
    </span>
  );
}
