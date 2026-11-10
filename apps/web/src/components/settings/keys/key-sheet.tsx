// Create an API key or an MCP token: a name, what it may do, optionally
// which projects, read-only or not, and when it expires. The token is shown
// once at the end. MCP tokens start read-only; a destructive call from one
// waits for a person in Approvals while the MCP server's "Ask before
// destructive actions" is on.

import { apiKeys, type OpOutput, projects } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Input } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { Switch } from "@seylo/ui/components/switch";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { ActionPicker } from "../action-picker";
import { allActions, compactActions, isViewAction, readOnlyActions } from "../actions";
import { useSettingsMutation } from "../mutation";
import { Field } from "../page";

type Kind = "api" | "mcp";
type Created = OpOutput<typeof apiKeys.create>;

const expiryChoices = ["never", "7", "30", "90", "365"] as const;

export function KeySheet({
  kind,
  open,
  onOpenChange,
  askBeforeDestructive = true,
}: {
  kind: Kind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** MCP tokens: whether destructive calls wait in Approvals (mcp.info), for the note under Read-only. */
  askBeforeDestructive?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl">
        {open && <KeyForm kind={kind} askBeforeDestructive={askBeforeDestructive} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

/** Which actions a key may hold: with projects picked, global actions would be useless (the panel drops them). */
function availableFor(projectScoped: boolean) {
  return projectScoped ? allActions.filter((info) => info.scope !== "global") : allActions;
}

function KeyForm({ kind, askBeforeDestructive, onDone }: { kind: Kind; askBeforeDestructive: boolean; onDone: () => void }) {
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(kind === "mcp");
  const [projectMode, setProjectMode] = useState<"all" | "some">("all");
  const [projectIds, setProjectIds] = useState<Set<string>>(new Set());
  const [actions, setActions] = useState<Set<string>>(
    () => new Set(kind === "mcp" ? readOnlyActions(allActions) : allActions.map((a) => a.action)),
  );
  const [expiry, setExpiry] = useState<(typeof expiryChoices)[number]>(kind === "mcp" ? "90" : "never");
  const [created, setCreated] = useState<Created | null>(null);
  const projectList = useOp(projects.list, {});
  const create = useSettingsMutation(apiKeys.create, { invalidates: [apiKeys.list], onSuccess: setCreated });

  const available = availableFor(projectMode === "some");
  // Read-only keys only keep query actions; narrowing projects drops global ones.
  const usable = available.filter((info) => !readOnly || isViewAction(info));
  const picked = new Set([...actions].filter((action) => usable.some((info) => info.action === action)));
  const valid = name.trim() !== "" && picked.size > 0 && (projectMode === "all" || projectIds.size > 0);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    create.mutate({
      kind,
      name: name.trim(),
      actions: compactActions(picked, usable),
      readOnly,
      ...(projectMode === "some" ? { projectIds: [...projectIds] } : {}),
      ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
    });
  }

  if (created) {
    const example = `curl -H "Authorization: Bearer ${created.token}" ${window.location.origin}/api/v1/system.info`;
    return (
      <>
        <SheetHeader>
          <SheetTitle>{t(`settingsKeys.create.createdTitle.${kind}`)}</SheetTitle>
          <SheetDescription>{t("settingsKeys.create.createdDescription")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <CreatedToken kind={kind} token={created.token} example={example} />
        </SheetBody>
        <SheetFooter>
          <Button variant="primary" onClick={onDone}>
            {t("settings.done")}
          </Button>
        </SheetFooter>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <SheetHeader>
        <SheetTitle>{t(`settingsKeys.create.title.${kind}`)}</SheetTitle>
        <SheetDescription>{t(`settingsKeys.create.description.${kind}`)}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        <Field label={t("settingsKeys.create.name")} hint={t(`settingsKeys.create.nameHint.${kind}`)} htmlFor="key-name">
          <Input id="key-name" value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="flex items-center gap-3 rounded-control bg-raised px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13.5px] font-medium">{t("settingsKeys.create.readOnly")}</span>
            <span className="text-[12.5px] text-muted-foreground">{t(`settingsKeys.create.readOnlyHint.${kind}`)}</span>
          </div>
          <Switch checked={readOnly} onCheckedChange={setReadOnly} aria-label={t("settingsKeys.create.readOnly")} />
        </div>
        {kind === "mcp" && !readOnly && (
          <Alert tone={askBeforeDestructive ? "info" : "warning"}>
            {t(askBeforeDestructive ? "settingsKeys.create.mcpWrites" : "settingsKeys.create.mcpWritesNoAsk")}
          </Alert>
        )}

        <Field label={t("settingsKeys.create.projects")}>
          <RadioGroup
            value={projectMode}
            onValueChange={(v) => setProjectMode(v as "all" | "some")}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <RadioCard value="all" title={t("settingsKeys.create.allProjects")} description={t("settingsKeys.create.allProjectsHint")} />
            <RadioCard value="some" title={t("settingsKeys.create.someProjects")} description={t("settingsKeys.create.someProjectsHint")} />
          </RadioGroup>
          {projectMode === "some" && (
            <div className="mt-2 flex flex-col gap-1.5 rounded-control bg-raised p-3">
              {projectList.data?.projects.length === 0 && (
                <span className="text-[13px] text-muted-foreground">{t("settingsPeople.grants.noProjects")}</span>
              )}
              {projectList.data?.projects.map((project) => {
                const id = `key-project-${project.id}`;
                return (
                  <div key={project.id} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={projectIds.has(project.id)}
                      onCheckedChange={(on) => {
                        const next = new Set(projectIds);
                        on === true ? next.add(project.id) : next.delete(project.id);
                        setProjectIds(next);
                      }}
                    />
                    <label htmlFor={id} className="cursor-pointer text-[13px]">
                      {project.name}
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </Field>

        <Field label={t("settingsKeys.create.actions")} hint={t("settingsKeys.create.actionsHint")}>
          <ActionPicker available={available} value={picked} onChange={setActions} readOnly={readOnly} />
        </Field>

        <Field label={t("settingsKeys.create.expires")} htmlFor="key-expiry">
          <Select value={expiry} onValueChange={(v) => setExpiry(v as (typeof expiryChoices)[number])}>
            <SelectTrigger id="key-expiry" className="sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {expiryChoices.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {choice === "never" ? t("settingsKeys.create.never") : t("settingsPeople.invite.days", { count: Number(choice) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </SheetBody>
      <SheetFooter>
        <Button onClick={onDone}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
          {create.isPending ? t("settings.saving") : t(`settingsKeys.create.submit.${kind}`)}
        </Button>
      </SheetFooter>
    </form>
  );
}

/**
 * The new key, shown once. An API key shows in the curl example under it
 * anyway, so it is in plain view; an MCP token stays dots until the eye is
 * pressed, for a screen being shared. Copy copies the real value either way.
 */
export function CreatedToken({ kind, token, example }: { kind: Kind; token: string; example: string }) {
  return (
    <>
      <Alert tone="warning">{t("settingsKeys.create.onlyOnce")}</Alert>
      <Field label={t("settingsKeys.create.token")}>
        <CopyField value={token} secret={kind === "mcp"} aria-label={t("settingsKeys.create.token")} />
      </Field>
      {kind === "api" ? (
        <CodeBlock title={t("settingsKeys.create.tryIt")} code={example} tone="dark" />
      ) : (
        <p className="m-0 text-[13px] text-muted-foreground">{t("settingsKeys.create.mcpNext")}</p>
      )}
    </>
  );
}
