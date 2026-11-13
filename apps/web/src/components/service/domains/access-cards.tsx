// The cards under the domain list (Domains.dc.html): first-run IP:port
// access, maintenance and down pages, and dev access (timed expose and the
// Cloudflare tunnel).

import { exposures, maintenance, type OpOutput, tunnels } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Dialog, DialogContent, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Switch } from "@seylo/ui/components/switch";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { type ChangeEvent, type ReactNode, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { Field, SwitchLabel } from "../field";
import { formatClock, formatDate } from "../format";
import { useInvalidate } from "../invalidate";
import { isNotBuilt, MutationError, OpErrorNote, retryOp } from "../op-state";
import { servicePort } from "../service-port";
import { oneHourMore } from "../timed-extend";
import { useNow } from "../use-now";
import type { ServiceDetail } from "../use-service";

function Panel({ label, title, badge, children }: { label: string; title: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-3 rounded-card bg-card px-5 py-[18px] shadow-card">
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      {children}
    </section>
  );
}

/** The node's host firewall is on: the command that opens this IP:port, so the link does not look dead. */
function FirewallHint({ label, command }: { label: string; command: string }) {
  return (
    <div className="flex flex-col gap-1.5 text-xs text-chip-amber-fg">
      <span>{label}</span>
      <CopyField value={command} tone="terminal" aria-label={label} />
    </div>
  );
}

const fail = (error: unknown) =>
  toast.error(isNotBuilt(error) ? t("service.notBuilt.title") : errorMessage(error, t("service.actionFailed")));

export function FirstRunCard({ service }: { service: ServiceDetail }) {
  const access = useOp(exposures.get, { serviceId: service.id }, { retry: retryOp });
  const invalidate = useInvalidate();
  const set = useOpMutation(exposures.setFirstRun, { onSuccess: () => invalidate(exposures.get), onError: fail });
  const first = access.data?.firstRun;
  const status = first?.status ?? "none";
  const tone = status === "open" ? "green" : status === "redirecting" ? "amber" : "gray";
  return (
    <Panel
      label={t("serviceDomains.firstRun.title")}
      title={t("serviceDomains.firstRun.title")}
      badge={access.data && <Chip tone={tone}>{t(`serviceDomains.firstRun.status.${status}`)}</Chip>}
    >
      {access.isPending ? (
        <LoadingRegion label={t("common.loading")} className="flex flex-col gap-2.5">
          <SkeletonText className="w-full text-[13px] leading-[1.55]" />
          <SkeletonText className="w-3/4 text-[13px] leading-[1.55]" />
          <SkeletonText className="w-52 text-[13px]" />
          <SkeletonText className="w-60 text-[13px]" />
          <ButtonSkeleton size="sm" className="w-24" />
        </LoadingRegion>
      ) : access.isError ? (
        <OpErrorNote error={access.error} compact />
      ) : (
        first && (
          <>
            <p className="m-0 text-[13px] leading-[1.55] text-ink-strong">
              {first.address ? (
                <>
                  {t("serviceDomains.firstRun.answersOn")}{" "}
                  <span className="rounded-[5px] bg-field px-[5px] py-px font-mono text-[12.5px] text-foreground">{first.address}</span>{" "}
                  {t("serviceDomains.firstRun.untilDomain")}{" "}
                  {first.domainLiveAt &&
                    (status === "redirecting" || status === "closed"
                      ? t("serviceDomains.firstRun.liveRedirects", { date: formatDate(first.domainLiveAt), url: first.redirectTo ?? "" })
                      : "")}
                </>
              ) : (
                t("serviceDomains.firstRun.none")
              )}
            </p>
            {first.address && first.firewallHint && status === "open" && (
              <FirewallHint label={t("serviceDomains.firstRun.firewall")} command={first.firewallHint} />
            )}
            <SwitchLabel
              checked={first.closeWhenDomainLive}
              onCheckedChange={(v) => set.mutate({ serviceId: service.id, closeWhenDomainLive: v })}
            >
              {t("serviceDomains.firstRun.closeWhenLive")}
            </SwitchLabel>
            <SwitchLabel
              checked={first.redirectToPrimary}
              onCheckedChange={(v) => set.mutate({ serviceId: service.id, redirectToPrimary: v })}
            >
              {t("serviceDomains.firstRun.redirect")}
            </SwitchLabel>
            {status !== "none" && (
              <Button
                size="sm"
                className="self-start bg-muted shadow-none"
                onClick={() => set.mutate({ serviceId: service.id, open: status === "closed" })}
              >
                {status === "closed" ? t("serviceDomains.firstRun.reopen") : t("serviceDomains.firstRun.closeNow")}
              </Button>
            )}
          </>
        )
      )}
    </Panel>
  );
}

export function MaintenanceCard({ service }: { service: ServiceDetail }) {
  const page = useOp(maintenance.get, { serviceId: service.id }, { retry: retryOp });
  const [preview, setPreview] = useState(false);
  const [editing, setEditing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidate();
  const set = useOpMutation(maintenance.set, {
    onSuccess: () => {
      invalidate(maintenance.get, maintenance.preview);
      toast.success(t("service.saved"));
    },
    onError: fail,
  });
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 512 * 1024) return void toast.error(t("serviceDomains.maintenance.tooBig"));
    set.mutate({ serviceId: service.id, html: await f.text() });
  };
  const data = page.data;
  return (
    <Panel label={t("serviceDomains.maintenance.title")} title={t("serviceDomains.maintenance.title")}>
      <p className="m-0 text-[13px] leading-[1.55] text-ink-strong">{t("serviceDomains.maintenance.body", { name: service.name })}</p>
      {page.isError ? (
        <OpErrorNote error={page.error} compact />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-[34px] bg-muted shadow-none" onClick={() => setPreview(true)} disabled={!data}>
            {t("serviceDomains.maintenance.preview")}
          </Button>
          <Button
            size="sm"
            className="h-[34px] bg-muted shadow-none"
            onClick={() => file.current?.click()}
            disabled={!data || set.isPending}
          >
            {t("serviceDomains.maintenance.upload")}
          </Button>
          {data?.pageSource === "service" && (
            <Button size="sm" variant="ghost" onClick={() => set.mutate({ serviceId: service.id, html: null })}>
              {t("serviceDomains.maintenance.useGlobal")}
            </Button>
          )}
          <Button size="sm" className="h-[34px] bg-muted shadow-none" onClick={() => setEditing(true)} disabled={!data}>
            {t("serviceDomains.maintenance.editMessage")}
          </Button>
          <input ref={file} type="file" accept=".html,text/html" className="hidden" onChange={(e) => void upload(e)} />
          <SwitchLabel
            className="ml-auto"
            checked={data?.enabled ?? false}
            disabled={!data}
            onCheckedChange={(v) => set.mutate({ serviceId: service.id, enabled: v })}
          >
            {t("serviceDomains.maintenance.mode")}
          </SwitchLabel>
        </div>
      )}
      {data?.globalEnabled && <span className="text-xs text-chip-amber-fg">{t("serviceDomains.maintenance.globalOn")}</span>}
      {data && <span className="text-xs text-muted-foreground">{t(`serviceDomains.maintenance.source.${data.pageSource}`)}</span>}
      {preview && <PreviewDialog serviceId={service.id} onClose={() => setPreview(false)} />}
      {editing && data && (
        <MessageDialog
          initial={data.message}
          busy={set.isPending}
          onClose={() => setEditing(false)}
          onSave={(message) => set.mutateAsync({ serviceId: service.id, message }).then(() => setEditing(false))}
        />
      )}
    </Panel>
  );
}

function PreviewDialog({ serviceId, onClose }: { serviceId: string; onClose: () => void }) {
  const html = useOp(maintenance.preview, { serviceId }, { retry: retryOp });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[8%] flex max-w-3xl flex-col gap-3">
        <DialogTitle>{t("serviceDomains.maintenance.preview")}</DialogTitle>
        {html.data ? (
          <iframe
            title={t("serviceDomains.maintenance.preview")}
            sandbox=""
            srcDoc={html.data.html}
            className="h-[60vh] w-full rounded-control border border-border bg-white"
          />
        ) : html.isError ? (
          <OpErrorNote error={html.error} />
        ) : (
          <Skeleton className="h-[60vh]" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MessageDialog({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSave: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState(initial);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-3">
        <DialogTitle>{t("serviceDomains.maintenance.message")}</DialogTitle>
        <Textarea
          rows={3}
          maxLength={500}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label={t("serviceDomains.maintenance.message")}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("service.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void onSave(message)}>
            {t("service.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const durations = [15, 60, 120, 480, 1440] as const;

export function DevAccessCard({ service }: { service: ServiceDetail }) {
  return (
    <section
      aria-label={t("serviceDomains.dev.title")}
      className="flex flex-col gap-3.5 rounded-card bg-card px-5 pt-[18px] pb-5 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{t("serviceDomains.dev.title")}</h2>
        <span className="text-[12.5px] text-muted-foreground">{t("serviceDomains.dev.hint")}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        <TimedExpose service={service} />
        <TunnelCard service={service} />
      </div>
    </section>
  );
}

type Timed = OpOutput<typeof exposures.get>["timed"][number];

function TimedExpose({ service }: { service: ServiceDetail }) {
  const access = useOp(exposures.get, { serviceId: service.id }, { retry: retryOp });
  const [opening, setOpening] = useState(false);
  const timed = access.data?.timed ?? [];
  return (
    <div className="flex flex-col gap-2.5 rounded-card bg-highlight px-4 py-3.5">
      <div className="flex items-center gap-2">
        <b className="text-[13.5px] font-semibold">{t("serviceDomains.dev.timed")}</b>
        <span className="ml-auto">
          {timed.length > 0 ? (
            <Chip tone="green">
              <StatusDot status="ok" pulse />
              {t("serviceDomains.dev.open")}
            </Chip>
          ) : (
            access.data && <Chip tone="gray">{t("serviceDomains.dev.closed")}</Chip>
          )}
        </span>
      </div>
      {access.isError && <OpErrorNote error={access.error} compact />}
      {timed.map((x) => (
        <TimedRow key={x.id} service={service} x={x} />
      ))}
      {opening ? (
        <OpenTimedForm service={service} onDone={() => setOpening(false)} />
      ) : (
        access.data && (
          <Button size="sm" className="self-start" onClick={() => setOpening(true)}>
            {t("serviceDomains.dev.openNew")}
          </Button>
        )
      )}
    </div>
  );
}

function TimedRow({ service, x }: { service: ServiceDetail; x: Timed }) {
  const now = useNow(1000);
  const invalidate = useInvalidate();
  const close = useOpMutation(exposures.close, { onSuccess: () => invalidate(exposures.get), onError: fail });
  const extend = useOpMutation(exposures.extendTimed, { onSuccess: () => invalidate(exposures.get), onError: fail });
  const left = Date.parse(x.expiresAt) - now;
  const by = t(`serviceDomains.dev.by.${x.openedBy.kind}`, { name: x.openedBy.name });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="rounded-chip bg-button px-2 py-1 font-mono shadow-button">
          {x.host}:{x.port ?? "…"} → {service.name}:{x.targetPort}
        </span>
        <span className="text-ink-strong">
          {t("serviceDomains.dev.onlyFrom", { cidrs: x.allowedCidrs.map((c) => c.replace(/\/(32|128)$/, "")).join(", ") })}
        </span>
      </div>
      {x.firewallHint && <FirewallHint label={t("serviceDomains.dev.firewall")} command={x.firewallHint} />}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-strong">
        {t("serviceDomains.dev.closesIn")} <b className="font-mono font-semibold text-foreground">{formatClock(Math.max(0, left))}</b> ·{" "}
        {by}
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            className="h-[30px] bg-card"
            onClick={() => extend.mutate({ serviceId: service.id, exposureId: x.id, durationMinutes: oneHourMore(left) })}
          >
            {t("serviceDomains.dev.extend")}
          </Button>
          <Button
            size="sm"
            className="h-[30px] bg-chip-red-bg text-chip-red-fg shadow-none"
            onClick={() => close.mutate({ serviceId: service.id, exposureId: x.id })}
          >
            {t("serviceDomains.dev.closeNow")}
          </Button>
        </span>
      </div>
    </>
  );
}

function OpenTimedForm({ service, onDone }: { service: ServiceDetail; onDone: () => void }) {
  const [port, setPort] = useState(servicePort(service));
  const [minutes, setMinutes] = useState(120);
  const [cidrs, setCidrs] = useState("");
  const invalidate = useInvalidate();
  const open = useOpMutation(exposures.openTimed, {
    onSuccess: () => {
      invalidate(exposures.get);
      onDone();
    },
  });
  const list = cidrs
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        open.mutate({ serviceId: service.id, targetPort: port, durationMinutes: minutes, ...(list.length ? { allowedCidrs: list } : {}) });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("serviceDomains.form.port")} htmlFor="t-port">
          <Input
            id="t-port"
            className="bg-card font-mono"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label={t("serviceDomains.dev.duration")}>
          <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
            <SelectTrigger aria-label={t("serviceDomains.dev.duration")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {durations.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d < 60 ? t("serviceDomains.dev.minutes", { count: d }) : t("serviceDomains.dev.hours", { count: d / 60 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t("serviceDomains.dev.allowedFrom")} htmlFor="t-cidrs" hint={t("serviceDomains.dev.allowedHint")}>
        <Input
          id="t-cidrs"
          className="bg-card font-mono"
          value={cidrs}
          onChange={(e) => setCidrs(e.target.value)}
          placeholder="198.51.100.24"
        />
      </Field>
      <MutationError error={open.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={open.isPending || port < 1}>
          {t("serviceDomains.dev.openAction")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("service.cancel")}
        </Button>
      </div>
    </form>
  );
}

function TunnelCard({ service }: { service: ServiceDetail }) {
  const tunnel = useOp(tunnels.get, { serviceId: service.id }, { retry: retryOp });
  const invalidate = useInvalidate();
  const [mode, setMode] = useState<"quick" | "token" | null>(null);
  const set = useOpMutation(tunnels.set, { onSuccess: () => invalidate(tunnels.get), onError: fail });
  const data = tunnel.data;
  const currentMode = mode ?? data?.mode ?? "quick";
  const stateTone = data?.state === "running" ? "green" : data?.state === "failed" ? "red" : data?.state === "starting" ? "amber" : "gray";
  return (
    <div className="flex flex-col gap-2.5 rounded-card bg-raised px-4 py-3.5">
      <div className="flex items-center gap-2">
        <b className="text-[13.5px] font-semibold">{t("serviceDomains.dev.tunnel")}</b>
        {/* The switch says on or off by itself; the state chip below says what the tunnel is doing. */}
        <Switch
          size="sm"
          className="ml-auto"
          checked={data?.enabled ?? false}
          disabled={!data || set.isPending}
          onCheckedChange={(on) => set.mutate({ serviceId: service.id, enabled: on, mode: currentMode })}
          aria-label={t("serviceDomains.dev.tunnel")}
        />
      </div>
      {tunnel.isError ? (
        <OpErrorNote error={tunnel.error} compact />
      ) : !data ? (
        <LoadingRegion label={t("common.loading")}>
          <Skeleton className="h-[38px]" />
        </LoadingRegion>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {data.url ? (
              <CopyField value={data.url} className="min-w-0 flex-1" aria-label={t("serviceDomains.dev.tunnel")} />
            ) : (
              <span className="rounded-chip bg-button px-2 py-1 font-mono shadow-button">
                {data.hostname ? `https://${data.hostname}` : t("serviceDomains.dev.quickUrl")}
              </span>
            )}
            <Chip tone={stateTone}>{t(`serviceDomains.dev.state.${data.state}`)}</Chip>
          </div>
          <Select value={currentMode} onValueChange={(v) => setMode(v as "quick" | "token")} disabled={data.enabled}>
            <SelectTrigger size="sm" aria-label={t("serviceDomains.dev.mode")} className="bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quick">{t("serviceDomains.dev.quick")}</SelectItem>
              <SelectItem value="token">{t("serviceDomains.dev.token")}</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {data.error ??
              (currentMode === "quick"
                ? data.expiresAt
                  ? t("serviceDomains.dev.quickUntil", { date: formatDate(data.expiresAt) })
                  : t("serviceDomains.dev.quickHint")
                : t(`serviceDomains.dev.tokenSource.${data.tokenSource}`))}
          </span>
        </>
      )}
    </div>
  );
}
