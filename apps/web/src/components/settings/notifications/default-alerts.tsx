// The "Default alerts" card of the Notifications board: one row per event
// with a checkbox, a hint, and which channels it goes to (a menu of
// channel checkboxes). Every change saves the whole rule list at once.

import { alerts, notifications } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Card } from "@seylo/ui/components/card";
import { Checkbox } from "@seylo/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@seylo/ui/components/dropdown-menu";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { IconChevronDown } from "@tabler/icons-react";
import { t } from "../../../i18n/t";
import { useSettingsMutation } from "../mutation";
import { QueryView } from "../op-state";

type Rule = notifications.AlertRule;
type Event = (typeof alerts.alertRuleEvents)[number];

export function DefaultAlerts({ channels, canEdit }: { channels: notifications.Channel[]; canEdit: boolean }) {
  const query = useOp(notifications.defaults, {});
  return (
    <Card className="min-w-0 flex-[1_1_380px] gap-1 px-5 pt-[18px] pb-2">
      <h2 className="m-0 text-[15px] font-semibold">{t("settingsNotifications.defaults.title")}</h2>
      <p className="m-0 mb-2 text-[12.5px] text-muted-foreground">{t("settingsNotifications.defaults.description")}</p>
      <QueryView query={query} skeleton={<RuleRowsSkeleton />}>
        {(data) => <RuleRows rules={data.rules} channels={channels} canEdit={canEdit} />}
      </QueryView>
    </Card>
  );
}

/** Every event with its real name and hint; only the checkbox and the channels wait for the data. */
function RuleRowsSkeleton() {
  return (
    <div className="flex flex-col">
      {alerts.alertRuleEvents.map((event) => (
        <div key={event} className="flex items-center gap-3 border-t border-divider py-2.5">
          <Skeleton className="size-4 shrink-0 rounded-[4px]" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[13px] font-medium">{t(`settingsNotifications.events.${event}.name`)}</span>
            <span className="text-xs text-muted-foreground">{t(`settingsNotifications.events.${event}.hint`)}</span>
          </span>
          <SkeletonText className="ml-auto w-16 px-1.5 py-1 text-xs" />
        </div>
      ))}
    </div>
  );
}

function RuleRows({ rules, channels, canEdit }: { rules: Rule[]; channels: notifications.Channel[]; canEdit: boolean }) {
  const save = useSettingsMutation(notifications.updateDefaults, { invalidates: [notifications.defaults, notifications.channels] });
  const byEvent = new Map(rules.map((rule) => [rule.event, rule]));
  const ruleFor = (event: Event): Rule => byEvent.get(event) ?? { event, enabled: false, channelIds: [] };

  function change(event: Event, patch: Partial<Rule>) {
    const next = alerts.alertRuleEvents.map((e) => (e === event ? { ...ruleFor(e), ...patch } : ruleFor(e)));
    save.mutate({ rules: next });
  }

  const names = new Map(channels.map((c) => [c.id, c.name]));

  return (
    <div className="flex flex-col">
      {alerts.alertRuleEvents.map((event) => {
        const rule = ruleFor(event);
        const id = `rule-${event}`;
        const to = rule.channelIds.map((cid) => names.get(cid)).filter(Boolean);
        return (
          <div key={event} className="flex items-center gap-3 border-t border-divider py-2.5">
            <Checkbox
              id={id}
              checked={rule.enabled}
              disabled={!canEdit || save.isPending}
              onCheckedChange={(on) => change(event, { enabled: on === true })}
            />
            <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col gap-0.5">
              <span className="text-[13px] font-medium">{t(`settingsNotifications.events.${event}.name`)}</span>
              <span className="text-xs text-muted-foreground">{t(`settingsNotifications.events.${event}.hint`)}</span>
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!canEdit || !rule.enabled}
                className="ml-auto flex max-w-[45%] shrink-0 cursor-pointer items-center gap-1 rounded-chip border-0 bg-transparent px-1.5 py-1 text-xs text-ink-strong hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="truncate">
                  {!rule.enabled ? "-" : to.length > 0 ? to.join(", ") : t("settingsNotifications.defaults.feedOnly")}
                </span>
                {canEdit && rule.enabled && <IconChevronDown size={13} className="shrink-0 text-ink-faint" />}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>{t("settingsNotifications.defaults.sendTo")}</DropdownMenuLabel>
                {channels.length === 0 && (
                  <DropdownMenuLabel className="font-normal text-muted-foreground">{t("settingsNotifications.empty")}</DropdownMenuLabel>
                )}
                {channels.map((channel) => (
                  <DropdownMenuCheckboxItem
                    key={channel.id}
                    checked={rule.channelIds.includes(channel.id)}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) =>
                      change(event, {
                        channelIds: on ? [...rule.channelIds, channel.id] : rule.channelIds.filter((cid) => cid !== channel.id),
                      })
                    }
                  >
                    {channel.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
