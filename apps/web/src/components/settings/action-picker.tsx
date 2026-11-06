// Checkboxes for permission actions, grouped by area, with quick picks for
// "everything" and "view only". Used by grants, invites and API keys.

import type { ActionInfo } from "@seylo/ops";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { cn } from "@seylo/ui/lib/utils";
import { useId } from "react";
import { t } from "../../i18n/t";
import { actionLabel, areaLabel, groupActions, isViewAction, readOnlyActions } from "./actions";

export function ActionPicker({
  available,
  value,
  onChange,
  readOnly = false,
  className,
}: {
  available: readonly ActionInfo[];
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Only query actions can be picked (read-only keys). */
  readOnly?: boolean;
  className?: string;
}) {
  const id = useId();
  const groups = groupActions(available);
  const usable = (info: ActionInfo) => !readOnly || isViewAction(info);

  function toggle(action: string, on: boolean) {
    const next = new Set(value);
    if (on) next.add(action);
    else next.delete(action);
    onChange(next);
  }

  function toggleGroup(actions: ActionInfo[], on: boolean) {
    const next = new Set(value);
    for (const info of actions) if (usable(info)) on ? next.add(info.action) : next.delete(info.action);
    onChange(next);
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onChange(new Set(available.filter(usable).map((info) => info.action)))}>
          {t("settingsPeople.picker.everything")}
        </Button>
        <Button size="sm" onClick={() => onChange(new Set(readOnlyActions(available)))}>
          {t("settingsPeople.picker.viewOnly")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(new Set())}>
          {t("settingsPeople.picker.none")}
        </Button>
        <span className="ml-auto self-center text-xs text-muted-foreground">
          {t("settingsPeople.picker.selected", {
            count: available.filter((info) => value.has(info.action)).length,
            total: available.length,
          })}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
        {groups.map((group) => {
          const usableActions = group.actions.filter(usable);
          const allOn = usableActions.length > 0 && usableActions.every((info) => value.has(info.action));
          const someOn = usableActions.some((info) => value.has(info.action));
          const groupId = `${id}-${group.area}`;
          return (
            <fieldset key={group.area} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1 flex items-center gap-2 p-0">
                <Checkbox
                  id={groupId}
                  checked={allOn ? true : someOn ? "indeterminate" : false}
                  disabled={usableActions.length === 0}
                  onCheckedChange={(on) => toggleGroup(group.actions, on === true)}
                />
                <label htmlFor={groupId} className="cursor-pointer text-[12.5px] font-semibold text-foreground">
                  {areaLabel(group.area)}
                </label>
              </legend>
              {group.actions.map((info) => {
                const itemId = `${id}-${info.action}`;
                const disabled = !usable(info);
                return (
                  <div key={info.action} className="flex items-center gap-2 pl-6">
                    <Checkbox
                      id={itemId}
                      checked={value.has(info.action)}
                      disabled={disabled}
                      onCheckedChange={(on) => toggle(info.action, on === true)}
                    />
                    <label
                      htmlFor={itemId}
                      className={cn("cursor-pointer text-[13px] text-ink-strong", disabled && "cursor-default text-ink-ghost")}
                    >
                      {actionLabel(info.action)}
                    </label>
                  </div>
                );
              })}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}
