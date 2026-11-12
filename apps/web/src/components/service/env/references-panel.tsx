// The References side panel (Environment.dc.html): every service of the
// project and the shared variables, with buttons that insert
// ${{target.VARIABLE}} at the cursor. Internal variables of services on
// other nodes are struck through, exposed ones too (their tip names the
// exposed variable to use instead); services with no way in get an Expose
// link instead.

import type { AnalyzeContext, ReferenceTarget, ReferenceVariable } from "@seylo/env-analyzer";
import { formatReference, missingNodes, pickPublicVariable } from "@seylo/env-analyzer";
import { Tip } from "@seylo/ui/components/tooltip";
import { cn } from "@seylo/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { t } from "../../../i18n/t";
import { badgeTones } from "../kind-badge";
import { isDatabaseKind, kindLook, type ServiceKind } from "../status";

export function ReferencesPanel({
  context,
  projectId,
  reveal,
  onInsert,
}: {
  context: AnalyzeContext;
  projectId: string;
  reveal: boolean;
  onInsert: (text: string) => void;
}) {
  const selfNodes = context.self.nodes.map((n) => n.name).join(", ");
  return (
    <aside
      aria-label={t("serviceEnv.refs.title")}
      className="flex max-w-[380px] min-w-0 flex-[1_1_320px] flex-col rounded-card bg-card shadow-card"
    >
      <div className="flex flex-col gap-1 border-b border-divider px-[18px] pt-4 pb-3">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceEnv.refs.title")}</h2>
        <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">
          {selfNodes ? t("serviceEnv.refs.hint", { nodes: selfNodes }) : t("serviceEnv.refs.hintNoNode")}
        </p>
      </div>
      <div className="flex flex-col px-[18px] pt-1.5 pb-4">
        {context.targets.length === 0 && <p className="m-0 py-3 text-[12.5px] text-muted-foreground">{t("serviceEnv.refs.empty")}</p>}
        {context.targets.map((target, i) => (
          <TargetGroup
            key={`${target.kind}:${target.name}`}
            target={target}
            context={context}
            projectId={projectId}
            reveal={reveal}
            first={i === 0}
            onInsert={onInsert}
          />
        ))}
      </div>
    </aside>
  );
}

function TargetGroup({
  target,
  context,
  projectId,
  reveal,
  first,
  onInsert,
}: {
  target: ReferenceTarget;
  context: AnalyzeContext;
  projectId: string;
  reveal: boolean;
  first: boolean;
  onInsert: (text: string) => void;
}) {
  const missing = target.kind === "service" ? missingNodes(context.self.nodes, target.nodes) : [];
  const sameNode = missing.length === 0;
  const anyReachable = target.variables.some((v) => v.scope !== "internal" || sameNode);
  const kind = target.serviceKind as ServiceKind | null;
  const look = kind && kind in kindLook ? kindLook[kind] : null;
  const where = target.nodes.map((n) => n.name).join(", ");
  const meta =
    target.kind === "shared"
      ? t("serviceEnv.refs.shared")
      : [
          where,
          target.exposed
            ? isDatabaseKind(kind ?? "")
              ? t("serviceEnv.refs.exposedSsl")
              : t("serviceEnv.refs.public")
            : t("serviceEnv.refs.internalOnly"),
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className={cn("flex flex-col gap-[9px] py-3", !first && "border-t border-divider")}>
      <div className="flex items-center gap-[9px] text-[13px]">
        <span
          className={cn(
            "flex h-6 w-[34px] shrink-0 items-center justify-center rounded-chip font-mono text-[10.5px] font-semibold",
            look ? badgeTones[look.tone] : badgeTones.gray,
          )}
        >
          {look?.badge ?? "ENV"}
        </span>
        <b className="font-semibold">{target.kind === "shared" ? t("serviceEnv.refs.project") : target.name}</b>
        <span className="truncate text-xs text-muted-foreground">{meta}</span>
      </div>
      {!anyReachable && !target.exposed && target.serviceId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-control bg-chip-amber-bg/60 px-3 py-[9px] text-[12.5px] text-ink-strong">
          {t("serviceEnv.refs.notReachable", { nodes: context.self.nodes.map((n) => n.name).join(", ") })}
          <Link
            to={isDatabaseKind(kind ?? "") ? "/p/$projectId/s/$serviceId/connection" : "/p/$projectId/s/$serviceId/domains"}
            params={{ projectId, serviceId: target.serviceId }}
            className="ml-auto font-medium"
          >
            {t("serviceEnv.fix.expose", { service: target.name })}
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {target.variables.map((v) => (
            <VariableButton
              key={v.name}
              target={target}
              variable={v}
              reachable={v.scope !== "internal" || sameNode}
              self={context.self}
              reveal={reveal}
              onInsert={onInsert}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VariableButton({
  target,
  variable,
  reachable,
  self,
  reveal,
  onInsert,
}: {
  target: ReferenceTarget;
  variable: ReferenceVariable;
  reachable: boolean;
  self: AnalyzeContext["self"];
  reveal: boolean;
  onInsert: (text: string) => void;
}) {
  const value =
    variable.value == null
      ? t("serviceEnv.hover.unknown")
      : variable.sensitive && !reveal
        ? t("serviceEnv.hover.hidden")
        : variable.value || t("serviceEnv.hover.empty");
  const tip = reachable ? (
    <span className="flex max-w-80 flex-col gap-1">
      {variable.description && <span>{variable.description}</span>}
      <span className="font-mono text-xs break-all">{value}</span>
    </span>
  ) : (
    unreachableTip(target, variable, self)
  );
  return (
    <Tip content={tip}>
      <button
        type="button"
        aria-disabled={!reachable}
        onClick={() => reachable && onInsert(formatReference(target.name, variable.name))}
        className={cn(
          "rounded-chip border-0 px-[9px] py-[5px] font-mono text-xs",
          reachable
            ? "cursor-pointer bg-chip-violet-bg font-medium text-chip-violet-fg hover:brightness-95"
            : "cursor-not-allowed bg-muted text-muted-foreground line-through",
        )}
      >
        {variable.name}
      </button>
    </Tip>
  );
}

/** Why an internal variable is struck through, and what to use instead when the target is exposed. */
function unreachableTip(target: ReferenceTarget, variable: ReferenceVariable, self: AnalyzeContext["self"]): string {
  const nodes = target.nodes.map((n) => n.name).join(", ");
  const instead = target.exposed ? pickPublicVariable(target, variable.name) : null;
  if (!instead) return t("serviceEnv.refs.unreachable", { nodes });
  return t("serviceEnv.refs.unreachableUse", {
    nodes,
    self: self.name,
    selfNodes: self.nodes.map((n) => n.name).join(", "),
    variable: instead,
  });
}
