// The Alerts tab: which of this service's events notify which channels
// (the panel defaults or its own rules), uptime checks with their 24-hour
// history, and the service's recent alerts.

import { alerts, notifications, type OpOutput, uptime } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { ButtonSkeleton, LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { SmoothChart } from "@seylo/ui/components/smooth-chart";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { cn } from "@seylo/ui/lib/utils";
import { IconChevronDown, IconDots, IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { Field, parseIntOrNull, ToggleRow } from "../field";
import { formatRelative } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { RowsSkeleton } from "../service-skeletons";
import type { ServiceDetail } from "../use-service";

type Rule = OpOutput<typeof notifications.serviceAlerts>["rules"][number];
type Check = OpOutput<typeof uptime.list>["checks"][number];
type Channel = OpOutput<typeof notifications.channels>["channels"][number];
const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function AlertsPage({ service }: { service: ServiceDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <RulesCard service={service} />
      <UptimeCard service={service} />
      <RecentAlerts service={service} />
    </div>
  );
}

function RulesCard({ service }: { service: ServiceDetail }) {
  const data = useOp(notifications.serviceAlerts, { serviceId: service.id }, { retry: retryOp });
  return (
    <SectionCard title={t("serviceAlerts.rulesTitle")} description={t("serviceAlerts.rulesBody")}>
      {data.isPending ? (
        // The events are fixed, so their names show right away; switches and channels wait for the rules.
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium">{t("serviceAlerts.useDefaults")}</span>
              <span className="text-[12.5px] leading-normal text-muted-foreground">{t("serviceAlerts.useDefaultsHint")}</span>
            </div>
            <Skeleton className="mt-0.5 h-5 w-9 shrink-0 rounded-full" />
          </div>
          <div className="flex flex-col">
            {alerts.serviceAlertEvents.map((event) => (
              <div key={event} className="flex items-center gap-3 border-t border-divider py-2.5 text-[13px]">
                <Skeleton className="h-4 w-7 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 text-muted-foreground">{t(`serviceAlerts.events.${event}`)}</span>
                <Skeleton className="h-8 w-24" />
              </div>
            ))}
          </div>
          <ButtonSkeleton className="w-[60px]" />
        </LoadingRegion>
      ) : data.isError ? (
        <OpErrorNote error={data.error} />
      ) : (
        <RulesEditor
          key={JSON.stringify(data.data)}
          service={service}
          useDefaults={data.data.useDefaults}
          rules={data.data.rules}
          defaults={data.data.defaults}
        />
      )}
    </SectionCard>
  );
}

function RulesEditor({
  service,
  useDefaults: initialDefaults,
  rules: initial,
  defaults,
}: {
  service: ServiceDetail;
  useDefaults: boolean;
  rules: Rule[];
  defaults: Rule[];
}) {
  const channels = useOp(notifications.channels, {}, { retry: retryOp });
  const [useDefaults, setUseDefaults] = useState(initialDefaults);
  const [rules, setRules] = useState<Rule[]>(() =>
    alerts.serviceAlertEvents.map(
      (event) =>
        initial.find((r) => r.event === event) ?? defaults.find((r) => r.event === event) ?? { event, enabled: false, channelIds: [] },
    ),
  );
  const invalidate = useInvalidate();
  const save = useOpMutation(notifications.updateServiceAlerts, {
    onSuccess: () => {
      invalidate(notifications.serviceAlerts);
      toast.success(t("service.saved"));
    },
  });
  const shown = useDefaults
    ? alerts.serviceAlertEvents.map((event) => defaults.find((r) => r.event === event) ?? { event, enabled: false, channelIds: [] })
    : rules;
  const list = channels.data?.channels ?? [];
  const set = (event: Rule["event"], patch: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.event === event ? { ...r, ...patch } : r)));

  return (
    <>
      <ToggleRow
        title={t("serviceAlerts.useDefaults")}
        description={t("serviceAlerts.useDefaultsHint")}
        control={<Switch checked={useDefaults} onCheckedChange={setUseDefaults} aria-label={t("serviceAlerts.useDefaults")} />}
      />
      {list.length === 0 && channels.data && (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("serviceAlerts.noChannels")} <Link to="/settings/notifications">{t("serviceAlerts.addChannel")}</Link>
        </p>
      )}
      <div className="flex flex-col">
        {shown.map((r) => (
          <div key={r.event} className="flex flex-wrap items-center gap-3 border-t border-divider py-2.5 text-[13px]">
            <Switch
              size="sm"
              checked={r.enabled}
              disabled={useDefaults}
              onCheckedChange={(enabled) => set(r.event, { enabled })}
              aria-label={t(`serviceAlerts.events.${r.event}`)}
            />
            <span className={cn("min-w-0 flex-1", !r.enabled && "text-muted-foreground")}>{t(`serviceAlerts.events.${r.event}`)}</span>
            <ChannelPicker
              channels={list}
              value={r.channelIds}
              disabled={useDefaults || !r.enabled}
              onChange={(channelIds) => set(r.event, { channelIds })}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={save.isPending}
          onClick={() => save.mutate({ serviceId: service.id, useDefaults, ...(useDefaults ? {} : { rules }) })}
        >
          {t("service.save")}
        </Button>
        <MutationError error={save.error} />
      </div>
    </>
  );
}

function ChannelPicker({
  channels,
  value,
  disabled,
  onChange,
}: {
  channels: Channel[];
  value: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const names = value.map((id) => channels.find((c) => c.id === id)?.name).filter(Boolean);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button size="sm" className="max-w-64 justify-between">
          <span className="truncate">{names.length ? names.join(", ") : t("serviceAlerts.feedOnly")}</span>
          <IconChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {channels.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={value.includes(c.id)}
            onCheckedChange={(on) => onChange(on ? [...value, c.id] : value.filter((id) => id !== c.id))}
            onSelect={(e) => e.preventDefault()}
          >
            {c.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const statusLook = {
  up: { tone: "green", dot: "ok" },
  down: { tone: "red", dot: "error" },
  pending: { tone: "amber", dot: "busy" },
  paused: { tone: "gray", dot: "off" },
} as const;

function UptimeCard({ service }: { service: ServiceDetail }) {
  const checks = useOp(uptime.list, { serviceId: service.id }, { retry: retryOp, refetchInterval: 60_000 });
  const [editing, setEditing] = useState<Check | "new" | null>(null);
  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceAlerts.uptime")}>
      <div className="flex flex-wrap items-center gap-2.5 px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceAlerts.uptime")}</h2>
        <span className="text-[12.5px] text-muted-foreground">{t("serviceAlerts.uptimeHint")}</span>
        <Button size="sm" variant="primary" className="ml-auto" onClick={() => setEditing("new")}>
          <IconPlus size={14} />
          {t("serviceAlerts.addCheck")}
        </Button>
      </div>
      {checks.isPending ? (
        <RowsSkeleton rows={1} lead="dot" width="w-44" />
      ) : checks.isError ? (
        <OpErrorNote error={checks.error} className="mx-5 mb-4" />
      ) : checks.data.checks.length === 0 ? (
        <div className="border-t border-divider">
          <EmptyState compact title={t("serviceAlerts.noChecks")} />
        </div>
      ) : (
        checks.data.checks.map((c) => <CheckRow key={c.id} service={service} check={c} onEdit={() => setEditing(c)} />)
      )}
      {editing && <CheckDialog service={service} check={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function CheckRow({ service, check: c, onEdit }: { service: ServiceDetail; check: Check; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const update = useOpMutation(uptime.update, { onSuccess: () => invalidate(uptime.list), onError: fail });
  const remove = useOpMutation(uptime.remove, { onSuccess: () => invalidate(uptime.list) });
  const look = statusLook[c.status];
  return (
    <div className="flex flex-col gap-2 border-t border-divider px-5 py-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-3">
        <Chip tone={look.tone}>
          <StatusDot status={look.dot} pulse={c.status === "down"} />
          {t(`serviceAlerts.status.${c.status}`)}
        </Chip>
        <b className="font-semibold">{c.name}</b>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {c.method} {c.url}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {c.uptime24h != null && <span>{t("serviceAlerts.uptime24h", { percent: c.uptime24h.toFixed(2) })}</span>}
          {c.lastLatencyMs != null && <span>{c.lastLatencyMs} ms</span>}
          {c.lastCheckedAt && <span>{formatRelative(c.lastCheckedAt)}</span>}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {t("serviceAlerts.history")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={t("serviceAlerts.checkActions", { name: c.name })}>
                <IconDots size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>{t("service.edit")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => update.mutate({ serviceId: service.id, checkId: c.id, enabled: !c.enabled })}>
                {c.enabled ? t("serviceAlerts.pause") : t("serviceAlerts.resume")}
              </DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => setConfirm(true)}>
                {t("service.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {c.lastError && c.status === "down" && <span className="text-[12.5px] text-chip-red-fg">{c.lastError}</span>}
      {open && <CheckHistory serviceId={service.id} checkId={c.id} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceAlerts.removeCheck", { name: c.name })}
        description={t("serviceAlerts.removeCheckBody")}
        confirmLabel={t("service.remove")}
        destructive
        onConfirm={() => remove.mutateAsync({ serviceId: service.id, checkId: c.id }).then(() => undefined)}
      />
    </div>
  );
}

function CheckHistory({ serviceId, checkId }: { serviceId: string; checkId: string }) {
  const history = useOp(uptime.history, { serviceId, checkId, range: "24h" }, { retry: retryOp });
  if (history.isPending)
    return (
      <LoadingRegion label={t("common.loading")}>
        <Skeleton className="h-24" />
      </LoadingRegion>
    );
  if (history.isError) return <OpErrorNote error={history.error} compact />;
  const h = history.data;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-4 text-xs text-muted-foreground">
        {h.uptimePercent != null && <span>{t("serviceAlerts.uptime24h", { percent: h.uptimePercent.toFixed(2) })}</span>}
        {h.avgLatencyMs != null && <span>{t("serviceAlerts.avgLatency", { ms: Math.round(h.avgLatencyMs) })}</span>}
        <span>{t("serviceAlerts.incidents", { count: h.incidents.length })}</span>
      </div>
      {h.points.length > 1 && (
        <SmoothChart
          aria-label={t("serviceAlerts.latency")}
          height={90}
          min={0}
          series={[{ id: "latency", label: t("serviceAlerts.latency"), values: h.points.map((p) => p.latencyMs) }]}
          formatValue={(v) => `${Math.round(v)} ms`}
        />
      )}
    </div>
  );
}

function CheckDialog({ service, check, onClose }: { service: ServiceDetail; check: Check | null; onClose: () => void }) {
  const primary = service.address && !service.address.includes(":") ? `https://${service.address}` : "";
  const [name, setName] = useState(check?.name ?? t("serviceAlerts.defaultName"));
  const [url, setUrl] = useState(check?.url ?? primary);
  const [interval, setIntervalSeconds] = useState(String(check?.intervalSeconds ?? 60));
  const [expected, setExpected] = useState(String(check?.expectedStatus ?? 0));
  const [threshold, setThreshold] = useState(String(check?.failureThreshold ?? 3));
  const invalidate = useInvalidate();
  const done = () => {
    invalidate(uptime.list);
    onClose();
  };
  const create = useOpMutation(uptime.create, { onSuccess: done });
  const update = useOpMutation(uptime.update, { onSuccess: done });
  const valid = name.trim() && /^https?:\/\/\S+$/.test(url.trim());
  const fields = {
    name: name.trim(),
    url: url.trim(),
    intervalSeconds: Math.max(30, parseIntOrNull(interval) ?? 60),
    expectedStatus: parseIntOrNull(expected) ?? 0,
    failureThreshold: Math.min(10, Math.max(1, parseIntOrNull(threshold) ?? 3)),
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[10%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            if (check) update.mutate({ serviceId: service.id, checkId: check.id, ...fields });
            else create.mutate({ serviceId: service.id, ...fields });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{check ? t("serviceAlerts.editCheck") : t("serviceAlerts.addCheck")}</DialogTitle>
            <DialogDescription>{t("serviceAlerts.checkBody")}</DialogDescription>
          </div>
          <Field label={t("serviceAlerts.checkName")} htmlFor="u-name">
            <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("serviceAlerts.url")} htmlFor="u-url">
            <Input
              id="u-url"
              className="font-mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://shop.example.com/health"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("serviceAlerts.interval")} htmlFor="u-int">
              <Input id="u-int" inputMode="numeric" value={interval} onChange={(e) => setIntervalSeconds(e.target.value)} />
            </Field>
            <Field label={t("serviceAlerts.expected")} htmlFor="u-exp" hint={t("serviceAlerts.expectedHint")}>
              <Input id="u-exp" inputMode="numeric" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
            <Field label={t("serviceAlerts.threshold")} htmlFor="u-thr">
              <Input id="u-thr" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </Field>
          </div>
          <MutationError error={create.error ?? update.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!valid || create.isPending || update.isPending}>
              {t("service.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const severityDot = { error: "error", warning: "busy", info: "off", ok: "ok" } as const;

function RecentAlerts({ service }: { service: ServiceDetail }) {
  const list = useOp(alerts.list, { serviceId: service.id, limit: 20 }, { retry: retryOp });
  return (
    <Card className="gap-0 overflow-hidden p-0" aria-label={t("serviceAlerts.recent")}>
      <div className="px-5 pt-4 pb-3.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceAlerts.recent")}</h2>
      </div>
      {list.isPending ? (
        <RowsSkeleton rows={2} lead="circle" width="w-48" action={false} />
      ) : list.isError ? (
        <OpErrorNote error={list.error} className="mx-5 mb-4" />
      ) : list.data.alerts.length === 0 ? (
        <div className="border-t border-divider">
          <EmptyState compact title={t("serviceAlerts.noAlerts")} />
        </div>
      ) : (
        list.data.alerts.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 border-t border-divider px-5 py-2.5 text-[13px]">
            <StatusDot status={severityDot[a.severity]} />
            <b className="font-semibold">{a.title}</b>
            <span className="min-w-0 flex-1 truncate text-ink-strong">{a.message}</span>
            {a.resolvedAt && <Chip tone="green">{t("serviceAlerts.resolved")}</Chip>}
            {a.muted && <Chip tone="gray">{t("serviceAlerts.muted")}</Chip>}
            <span className="text-xs text-muted-foreground">{formatRelative(a.createdAt)}</span>
          </div>
        ))
      )}
    </Card>
  );
}
