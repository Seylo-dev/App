// The References side panel (Environment.dc.html): the service being
// edited first, with its own built-ins (URL, DOMAIN, INTERNAL_URL, ... or a
// database's set) and never its own .env variables (the analyzer refuses a
// reference to another line of the same file, it could loop), then every
// other service of the project and the shared variables, with buttons that
// insert ${{target.VARIABLE}} at the cursor (${{<its name>.DOMAIN}} for the
// service itself). A panel that sends no self.builtins (before 0.2.8) gets
// no group for the service itself. Internal variables of services on other
// nodes are struck through, exposed ones too (their tip names the exposed
// variable to use instead); services with no way in get an Expose link
// instead. A variable whose value is empty right now (URL and DOMAIN
// before a domain, an empty shared variable) gets no chip, and a group left
// with none is not shown; a reference to it is still valid (the editor
// completes it) and resolves once it has a value. A null value is one the
// caller may not see or that is not known yet, not an empty one: it keeps
// its chip. The one exception is a database's EXPOSED_URL: it carries the
// password, so it is null for a caller without databases.credentials also
// while the database is not exposed; EXPOSED_HOST (never hidden) says that.

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
  serviceKind,
  projectId,
  reveal,
  onInsert,
}: {
  context: AnalyzeContext;
  /** Kind of the service being edited, for its badge (the context does not carry it). */
  serviceKind: string;
  projectId: string;
  reveal: boolean;
  onInsert: (text: string) => void;
}) {
  const selfNodes = context.self.nodes.map((n) => n.name).join(", ");
  const own = context.self.name ? withValue(context.self.builtins ?? [], isDatabaseKind(serviceKind)) : [];
  // Each group with only the chips it shows, so whether it is reachable and what its tips suggest go by those.
  const targets = context.targets
    .map((target) => ({ ...target, variables: withValue(target.variables, isDatabaseKind(target.serviceKind ?? "")) }))
    .filter((target) => target.variables.length > 0);
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
        {own.length > 0 && <SelfGroup name={context.self.name} kind={serviceKind} builtins={own} reveal={reveal} onInsert={onInsert} />}
        {targets.length === 0 && (
          <p className={cn("m-0 py-3 text-[12.5px] text-muted-foreground", own.length > 0 && "border-t border-divider")}>
            {own.length > 0 ? t("serviceEnv.refs.emptyOthers") : t("serviceEnv.refs.empty")}
          </p>
        )}
        {targets.map((target, i) => (
          <TargetGroup
            key={`${target.kind}:${target.name}`}
            target={target}
            context={context}
            projectId={projectId}
            reveal={reveal}
            first={i === 0 && own.length === 0}
            onInsert={onInsert}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * The service being edited: only its own built-ins, always usable (it runs
 * where it runs), each inserting ${{<its name>.VARIABLE}} like the other groups.
 */
function SelfGroup({
  name,
  kind,
  builtins,
  reveal,
  onInsert,
}: {
  name: string;
  kind: string;
  builtins: ReferenceVariable[];
  reveal: boolean;
  onInsert: (text: string) => void;
}) {
  return (
    <div className="flex flex-col gap-[9px] py-3">
      <GroupHeader kind={kind} name={name} meta={t("serviceEnv.refs.thisService")} />
      <div className="flex flex-wrap gap-1.5">
        {builtins.map((v) => (
          <VariableButton key={v.name} targetName={name} variable={v} unreachable={null} reveal={reveal} onInsert={onInsert} />
        ))}
      </div>
    </div>
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
  const kind = target.serviceKind;
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
      <GroupHeader kind={kind} name={target.kind === "shared" ? t("serviceEnv.refs.project") : target.name} meta={meta} />
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
              targetName={target.name}
              variable={v}
              unreachable={v.scope !== "internal" || sameNode ? null : unreachableTip(target, v, context.self)}
              reveal={reveal}
              onInsert={onInsert}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A group's kind badge (ENV for the shared variables), its name and one line about it. */
function GroupHeader({ kind, name, meta }: { kind: string | null; name: string; meta: string }) {
  const look = kind && kind in kindLook ? kindLook[kind as ServiceKind] : null;
  return (
    <div className="flex items-center gap-[9px] text-[13px]">
      <span
        className={cn(
          "flex h-6 w-[34px] shrink-0 items-center justify-center rounded-chip font-mono text-[10.5px] font-semibold",
          look ? badgeTones[look.tone] : badgeTones.gray,
        )}
      >
        {look?.badge ?? "ENV"}
      </span>
      <b className="font-semibold">{name}</b>
      <span className="truncate text-xs text-muted-foreground">{meta}</span>
    </div>
  );
}

/**
 * Whether a variable gets a chip: not when its value is empty right now.
 * Null (hidden from the caller, or not known yet) is not empty.
 */
export function hasValue(variable: ReferenceVariable): boolean {
  return variable.value !== "";
}

/**
 * The variables of one group that get a chip (hasValue). A database's
 * EXPOSED_URL is null for a caller without databases.credentials, also while
 * the database is not exposed and it is empty: an empty EXPOSED_HOST, which
 * nobody is refused, means it is empty too.
 */
export function withValue(variables: ReferenceVariable[], database: boolean): ReferenceVariable[] {
  const notExposed = database && variables.some((v) => v.name === "EXPOSED_HOST" && v.value === "");
  return variables.filter((v) => hasValue(v) && !(notExposed && v.name === "EXPOSED_URL" && v.value === null));
}

/** The value line of a variable's tip: its value, or why it is not shown. Empty ones have no chip (hasValue). */
export function shownValue(variable: ReferenceVariable, reveal: boolean): string {
  if (variable.value == null) return t("serviceEnv.hover.unknown");
  if (variable.sensitive && !reveal) return t("serviceEnv.hover.hidden");
  return variable.value;
}

function VariableButton({
  targetName,
  variable,
  unreachable,
  reveal,
  onInsert,
}: {
  targetName: string;
  variable: ReferenceVariable;
  /** Why it does not work from here (it is struck through), or null when it does. */
  unreachable: string | null;
  reveal: boolean;
  onInsert: (text: string) => void;
}) {
  const reachable = unreachable === null;
  const tip = reachable ? (
    <span className="flex max-w-80 flex-col gap-1">
      {variable.description && <span>{variable.description}</span>}
      <span className="font-mono text-xs break-all">{shownValue(variable, reveal)}</span>
    </span>
  ) : (
    unreachable
  );
  return (
    <Tip content={tip}>
      <button
        type="button"
        aria-disabled={!reachable}
        onClick={() => reachable && onInsert(formatReference(targetName, variable.name))}
        className={cn(
          "rounded-chip border-0 px-[9px] py-[5px] font-mono text-xs transition-interactive duration-200",
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
