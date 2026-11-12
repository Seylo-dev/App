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
// A service built from a repository is told that each deploy also sets
// GIT_SHA (panel env/git-sha.ts).
// The title and hint stay at the top while the groups scroll inside the
// card, no taller than the editor next to it, with no scrollbar (the edge
// that hides groups fades). Each group collapses and expands on its header
// row; a long one starts collapsed with its count (references-collapse.ts).

import type { AnalyzeContext, ReferenceTarget, ReferenceVariable } from "@seylo/env-analyzer";
import { formatReference, missingNodes, pickPublicVariable } from "@seylo/env-analyzer";
import { Tip } from "@seylo/ui/components/tooltip";
import { scrollFadeColumnRef } from "@seylo/ui/lib/scroll-fade";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { t } from "../../../i18n/t";
import { badgeTones } from "../kind-badge";
import { isDatabaseKind, kindLook, type ServiceKind } from "../status";
import {
  groupKey,
  isCollapsed,
  type RefGroup,
  selfGroupKey,
  setAllCollapsed,
  toggleCollapsed,
  useCollapseChoices,
} from "./references-collapse";

/**
 * The References column next to the editor (the panel, its skeleton and its
 * error), in a row that is a size container (`@container`): 320px wide
 * until the editor has 600px, then it takes the room past that up to 440px
 * (the editor grows from there). It wraps under the editor when the editor
 * would get less than 520px, and alone on its line it is up to 440px wide.
 */
export const referencesColumn = "max-w-[440px] min-w-0 flex-[1_1_clamp(320px,100cqw_-_616px,440px)]";

/** Sources whose deploys build a commit of a repository: their deployments get GIT_SHA. */
export function buildsFromRepository(source: { type: string }): boolean {
  return source.type === "github" || source.type === "provider" || source.type === "git";
}

export function ReferencesPanel({
  context,
  serviceKind,
  projectId,
  reveal,
  builtFromRepository = false,
  maxHeight,
  onInsert,
}: {
  context: AnalyzeContext;
  /** Kind of the service being edited, for its badge (the context does not carry it). */
  serviceKind: string;
  projectId: string;
  reveal: boolean;
  /** The service builds from a repository: its deployments also get GIT_SHA (panel env/git-sha.ts). */
  builtFromRepository?: boolean;
  /** The editor's height: the panel grows no taller, its groups scroll inside. */
  maxHeight?: number;
  onInsert: (text: string) => void;
}) {
  const selfNodes = context.self.nodes.map((n) => n.name).join(", ");
  const own = context.self.name ? withValue(context.self.builtins ?? [], isDatabaseKind(serviceKind)) : [];
  // Each group with only the chips it shows, so whether it is reachable and what its tips suggest go by those.
  const targets = context.targets
    .map((target) => ({ ...target, variables: withValue(target.variables, isDatabaseKind(target.serviceKind ?? "")) }))
    .filter((target) => target.variables.length > 0);
  const [choices, setChoices] = useCollapseChoices(projectId);
  const selfGroup: RefGroup = { key: selfGroupKey, chips: own.length };
  const groups: RefGroup[] = [
    ...(own.length > 0 ? [selfGroup] : []),
    ...targets.map((target) => ({ key: groupKey(target), chips: target.variables.length })),
  ];
  // One button for all groups: it expands them while any is collapsed, else it collapses them.
  const anyCollapsed = groups.some((group) => isCollapsed(choices, group));
  const fold = (group: RefGroup) => ({
    collapsed: isCollapsed(choices, group),
    onToggle: () => setChoices(toggleCollapsed(choices, group)),
  });
  return (
    <aside
      aria-label={t("serviceEnv.refs.title")}
      className={cn(referencesColumn, "flex flex-col rounded-card bg-card shadow-card")}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-divider px-[18px] pt-4 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceEnv.refs.title")}</h2>
          {groups.length > 1 && (
            <button
              type="button"
              onClick={() => setChoices(setAllCollapsed(choices, groups, !anyCollapsed))}
              className="-my-1 ml-auto cursor-pointer rounded-control border-0 bg-transparent px-2 py-1 text-xs font-medium text-link transition-interactive duration-200 hover:bg-muted hover:text-link-hover"
            >
              {t(anyCollapsed ? "serviceEnv.refs.expandAll" : "serviceEnv.refs.collapseAll")}
            </button>
          )}
        </div>
        <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">
          {selfNodes ? t("serviceEnv.refs.hint", { nodes: selfNodes }) : t("serviceEnv.refs.hintNoNode")}
        </p>
        {builtFromRepository && <p className="m-0 text-[12.5px] leading-normal text-muted-foreground">{t("serviceEnv.refs.gitSha")}</p>}
      </div>
      <div ref={scrollFadeColumnRef} data-slot="references-list" className="scroll-column min-h-0 flex-auto px-[18px] pt-1.5 pb-4">
        {own.length > 0 && (
          <SelfGroup name={context.self.name} kind={serviceKind} builtins={own} reveal={reveal} onInsert={onInsert} {...fold(selfGroup)} />
        )}
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
            {...fold({ key: groupKey(target), chips: target.variables.length })}
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
  collapsed,
  onToggle,
  onInsert,
}: {
  name: string;
  kind: string;
  builtins: ReferenceVariable[];
  reveal: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onInsert: (text: string) => void;
}) {
  return (
    <Group
      first
      kind={kind}
      name={name}
      meta={t("serviceEnv.refs.thisService")}
      count={builtins.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <div className="flex flex-wrap gap-1.5">
        {builtins.map((v) => (
          <VariableButton key={v.name} targetName={name} variable={v} unreachable={null} reveal={reveal} onInsert={onInsert} />
        ))}
      </div>
    </Group>
  );
}

function TargetGroup({
  target,
  context,
  projectId,
  reveal,
  first,
  collapsed,
  onToggle,
  onInsert,
}: {
  target: ReferenceTarget;
  context: AnalyzeContext;
  projectId: string;
  reveal: boolean;
  first: boolean;
  collapsed: boolean;
  onToggle: () => void;
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
    <Group
      first={first}
      kind={kind}
      name={target.kind === "shared" ? t("serviceEnv.refs.project") : target.name}
      meta={meta}
      count={target.variables.length}
      collapsed={collapsed}
      onToggle={onToggle}
    >
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
    </Group>
  );
}

/**
 * One group: its header row (the kind badge, ENV for the shared variables,
 * its name and one line about it) collapses and expands it by click, Enter
 * or Space. Collapsed, the header says how many chips it holds and the
 * chips are not rendered, so Tab skips them.
 */
function Group({
  first,
  kind,
  name,
  meta,
  count,
  collapsed,
  onToggle,
  children,
}: {
  first: boolean;
  kind: string | null;
  name: string;
  meta: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const look = kind && kind in kindLook ? kindLook[kind as ServiceKind] : null;
  const body = useId();
  // The chips fade in when someone expands the group, not when the page opens.
  const [toggled, setToggled] = useState(false);
  return (
    <div className={cn("flex flex-col gap-[9px] py-3", !first && "border-t border-divider")}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : body}
        onClick={() => {
          setToggled(true);
          onToggle();
        }}
        className="-mx-2 -my-1 flex min-w-0 cursor-pointer items-center gap-[9px] rounded-control border-0 bg-transparent px-2 py-1 text-left text-[13px] transition-interactive duration-200 hover:bg-muted"
      >
        <span
          className={cn(
            "flex h-6 w-[34px] shrink-0 items-center justify-center rounded-chip font-mono text-[10.5px] font-semibold",
            look ? badgeTones[look.tone] : badgeTones.gray,
          )}
        >
          {look?.badge ?? "ENV"}
        </span>
        <b className="font-semibold">{name}</b>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {collapsed && t("serviceEnv.refs.count", { count })}
          <IconChevronDown
            size={14}
            stroke={2}
            aria-hidden="true"
            className={cn("transition-transform duration-200", collapsed && "-rotate-90")}
          />
        </span>
      </button>
      {!collapsed && (
        <div id={body} className={cn(toggled && "animate-in fade-in-0 duration-200")}>
          {children}
        </div>
      )}
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
