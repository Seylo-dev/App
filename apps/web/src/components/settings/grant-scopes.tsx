// Picks projects and services and what someone may do on each: the grant
// list of an invite, and the "add access" form on a person's sheet. A
// project grant covers the project's services; a service grant only that
// service.

import { projects, services } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { t } from "../../i18n/t";
import { ActionPicker } from "./action-picker";
import { type GrantKind, grantable, readOnlyActions, summarizeActions } from "./actions";

export interface GrantDraft {
  scopeType: GrantKind;
  scopeId: string;
  scopeName: string;
  /** Project name for service grants, for the label. */
  projectName: string | null;
  actions: Set<string>;
}

const wholeProject = "__project";

/** Project + service selects and an Add button; calls onAdd with a new draft (view-only actions to start). */
export function ScopePicker({
  exclude,
  onAdd,
  addLabel,
}: {
  /** "project:<id>" / "service:<id>" keys already in the list. */
  exclude: ReadonlySet<string>;
  onAdd: (draft: GrantDraft) => void;
  addLabel?: string;
}) {
  const projectList = useOp(projects.list, {});
  const [projectId, setProjectId] = useState<string>("");
  const [serviceId, setServiceId] = useState<string>(wholeProject);
  const serviceList = useOp(services.list, { projectId }, { enabled: projectId !== "" });
  const project = projectList.data?.projects.find((p) => p.id === projectId);
  const service = serviceList.data?.services.find((s) => s.id === serviceId);
  const key = serviceId === wholeProject ? `project:${projectId}` : `service:${serviceId}`;

  function add() {
    if (!project) return;
    const scopeType: GrantKind = service ? "service" : "project";
    onAdd({
      scopeType,
      scopeId: service ? service.id : project.id,
      scopeName: service ? service.name : project.name,
      projectName: service ? project.name : null,
      actions: new Set(readOnlyActions(grantable(scopeType))),
    });
    setServiceId(wholeProject);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Select
          value={projectId}
          onValueChange={(next) => {
            setProjectId(next);
            setServiceId(wholeProject);
          }}
        >
          <SelectTrigger aria-label={t("settingsPeople.grants.project")}>
            <SelectValue placeholder={projectList.isPending ? t("common.loading") : t("settingsPeople.grants.pickProject")} />
          </SelectTrigger>
          <SelectContent>
            {projectList.data?.projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={serviceId} onValueChange={setServiceId} disabled={projectId === ""}>
          <SelectTrigger aria-label={t("settingsPeople.grants.service")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={wholeProject}>{t("settingsPeople.grants.wholeProject")}</SelectItem>
            {serviceList.data?.services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={add} disabled={!project || exclude.has(key)}>
          <IconPlus size={15} stroke={1.8} />
          {addLabel ?? t("settingsPeople.grants.add")}
        </Button>
      </div>
      {projectList.data?.projects.length === 0 && (
        <p className="m-0 text-xs text-muted-foreground">{t("settingsPeople.grants.noProjects")}</p>
      )}
      {serviceList.error && <p className="m-0 text-xs text-muted-foreground">{t("settingsPeople.grants.servicesUnavailable")}</p>}
    </div>
  );
}

export function scopeKey(draft: Pick<GrantDraft, "scopeType" | "scopeId">): string {
  return `${draft.scopeType}:${draft.scopeId}`;
}

/** The name shown for a grant: "web (in shop)" for services, the project name otherwise. */
export function ScopeName({ draft }: { draft: Pick<GrantDraft, "scopeType" | "scopeName" | "projectName"> }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Chip tone={draft.scopeType === "project" ? "blue" : "violet"}>{t(`settingsPeople.grants.kinds.${draft.scopeType}`)}</Chip>
      <span className="truncate font-medium">{draft.scopeName || t("settingsPeople.grants.deleted")}</span>
      {draft.projectName && (
        <span className="truncate text-xs text-muted-foreground">
          {t("settingsPeople.grants.inProject", { project: draft.projectName })}
        </span>
      )}
    </span>
  );
}

/** The grant list of an invite: each grant folds open to its action checkboxes. */
export function GrantListEditor({ value, onChange }: { value: GrantDraft[]; onChange: (next: GrantDraft[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const keys = new Set(value.map(scopeKey));
  return (
    <div className="flex flex-col gap-2">
      {value.map((draft, index) => {
        const key = scopeKey(draft);
        const expanded = open === key;
        return (
          <div key={key} className="rounded-control bg-raised px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ScopeName draft={draft} />
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{summarizeActions([...draft.actions])}</span>
              <Button
                size="icon"
                variant="ghost"
                aria-expanded={expanded}
                aria-label={t("settingsPeople.grants.editActions")}
                onClick={() => setOpen(expanded ? null : key)}
              >
                {expanded ? <IconChevronUp size={15} /> : <IconChevronDown size={15} />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("settings.remove")}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <IconTrash size={15} />
              </Button>
            </div>
            {expanded && (
              <ActionPicker
                className="mt-3 border-t border-divider pt-3"
                available={grantable(draft.scopeType)}
                value={draft.actions}
                onChange={(actions) => onChange(value.map((d, i) => (i === index ? { ...d, actions } : d)))}
              />
            )}
          </div>
        );
      })}
      <ScopePicker
        exclude={keys}
        onAdd={(draft) => {
          onChange([...value, draft]);
          setOpen(scopeKey(draft));
        }}
      />
    </div>
  );
}
