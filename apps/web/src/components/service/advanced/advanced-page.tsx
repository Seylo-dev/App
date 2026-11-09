// The Advanced tab: health check and deploy strategy, crash policy (with
// the fixed 5 second wait), replicas per node and sticky sessions, moving
// to another node, resource limits (all off by default), container
// settings and ports, a cron service's schedule, and the maintenance page.

import { builds, type OpInput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { isPanelService } from "../../../lib/service-display";
import { describeCron } from "../cron-text";
import { MaintenanceCard } from "../domains/access-cards";
import { Field, FieldGrid, parseIntOrNull, ToggleRow } from "../field";
import { volumesOf } from "../files/volumes";
import { useInvalidate } from "../invalidate";
import { MutationError, retryOp } from "../op-state";
import { servicePort } from "../service-port";
import type { ServiceDetail } from "../use-service";
import { joinArgs, splitArgs } from "./args";

type HealthCheck = NonNullable<ServiceDetail["healthCheck"]>;
type ProbeType = "default" | HealthCheck["probe"]["type"];
const mb = 1_000_000;

function useSaved(...ops: { id: string }[]) {
  const invalidate = useInvalidate();
  return () => {
    invalidate(services.get, ...ops);
    toast.success(t("service.saved"));
  };
}

export function AdvancedPage({ service }: { service: ServiceDetail }) {
  const runs = service.kind === "app" || service.kind === "cron";
  return (
    <div className="flex flex-col gap-4">
      {service.kind === "cron" && <CronScheduleCard service={service} />}
      {service.kind !== "cron" && <HealthCard service={service} />}
      <CrashCard service={service} />
      {service.kind !== "cron" && !isPanelService(service) && <PlacementCard service={service} />}
      {!isPanelService(service) && <MoveCard service={service} />}
      <ResourcesCard service={service} />
      {runs && <ContainerCard service={service} />}
      {service.kind === "app" && <MaintenanceCard service={service} />}
    </div>
  );
}

function HealthCard({ service }: { service: ServiceDetail }) {
  const hc = service.healthCheck;
  const firstPort = servicePort(service);
  const [type, setType] = useState<ProbeType>(hc?.probe.type ?? "default");
  const [port, setPort] = useState(String(hc && hc.probe.type !== "command" ? hc.probe.port : firstPort));
  const [path, setPath] = useState(hc?.probe.type === "http" ? hc.probe.path : "/health");
  const [host, setHost] = useState(hc?.probe.type === "http" ? hc.probe.host : "");
  const [status, setStatus] = useState(String(hc?.probe.type === "http" ? hc.probe.expectedStatus : 0));
  const [command, setCommand] = useState(hc?.probe.type === "command" ? joinArgs(hc.probe.command) : "");
  const [interval, setIntervalSeconds] = useState(String(hc?.intervalSeconds ?? 5));
  const [timeout, setTimeoutSeconds] = useState(String(hc?.timeoutSeconds ?? 3));
  const [start, setStart] = useState(String(hc?.startPeriodSeconds ?? 10));
  const [failures, setFailures] = useState(String(hc?.failureThreshold ?? 3));
  const [mode, setMode] = useState(service.deploy.mode);
  const [healthTimeout, setHealthTimeout] = useState(String(service.deploy.healthTimeoutSeconds));
  const save = useOpMutation(services.setHealthCheck, { onSuccess: useSaved() });

  const submit = () => {
    const n = (s: string, d: number) => parseIntOrNull(s) ?? d;
    const probe: HealthCheck["probe"] | null =
      type === "tcp"
        ? { type: "tcp", port: n(port, firstPort) }
        : type === "http"
          ? { type: "http", port: n(port, firstPort), path: path.startsWith("/") ? path : `/${path}`, host, expectedStatus: n(status, 0) }
          : type === "command"
            ? { type: "command", command: splitArgs(command) }
            : null;
    save.mutate({
      serviceId: service.id,
      healthCheck: probe
        ? {
            probe,
            intervalSeconds: n(interval, 5),
            timeoutSeconds: n(timeout, 3),
            startPeriodSeconds: n(start, 10),
            failureThreshold: n(failures, 3),
          }
        : null,
      deploy: { mode, healthTimeoutSeconds: n(healthTimeout, 60) },
    });
  };

  return (
    <SectionCard
      title={t("serviceAdvanced.health.title")}
      description={t("serviceAdvanced.health.description")}
      footer={
        <>
          <Button size="sm" variant="primary" onClick={submit} disabled={save.isPending}>
            {t("service.save")}
          </Button>
          <span>{t("serviceAdvanced.nextDeploy")}</span>
          <MutationError error={save.error} />
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t("serviceAdvanced.health.probe")}>
          <Select value={type} onValueChange={(v) => setType(v as ProbeType)}>
            <SelectTrigger aria-label={t("serviceAdvanced.health.probe")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["default", "tcp", "http", "command"] as const).map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`serviceAdvanced.health.probes.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {(type === "tcp" || type === "http") && (
          <Field label={t("serviceAdvanced.health.port")} htmlFor="h-port">
            <Input id="h-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
          </Field>
        )}
        {type === "http" && (
          <>
            <Field label={t("serviceAdvanced.health.path")} htmlFor="h-path">
              <Input id="h-path" className="font-mono" value={path} onChange={(e) => setPath(e.target.value)} />
            </Field>
            <Field label={t("serviceAdvanced.health.host")} htmlFor="h-host" hint={t("serviceAdvanced.health.hostHint")}>
              <Input id="h-host" className="font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <Field label={t("serviceAdvanced.health.status")} htmlFor="h-status" hint={t("serviceAdvanced.health.statusHint")}>
              <Input id="h-status" inputMode="numeric" value={status} onChange={(e) => setStatus(e.target.value)} />
            </Field>
          </>
        )}
        {type === "command" && (
          <Field
            label={t("serviceAdvanced.health.command")}
            htmlFor="h-cmd"
            hint={t("serviceAdvanced.health.commandHint")}
            className="md:col-span-2"
          >
            <Input
              id="h-cmd"
              className="font-mono"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="sh -c 'curl -fs localhost:3000/health'"
            />
          </Field>
        )}
      </div>
      {type === "default" && <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceAdvanced.health.defaultHint")}</p>}
      {type !== "default" && (
        <FieldGrid className="grid-cols-2 md:grid-cols-4">
          <Field label={t("serviceAdvanced.health.interval")} htmlFor="h-int">
            <Input id="h-int" inputMode="numeric" value={interval} onChange={(e) => setIntervalSeconds(e.target.value)} />
          </Field>
          <Field label={t("serviceAdvanced.health.timeout")} htmlFor="h-to">
            <Input id="h-to" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutSeconds(e.target.value)} />
          </Field>
          <Field label={t("serviceAdvanced.health.startPeriod")} htmlFor="h-sp">
            <Input id="h-sp" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label={t("serviceAdvanced.health.failures")} htmlFor="h-fail">
            <Input id="h-fail" inputMode="numeric" value={failures} onChange={(e) => setFailures(e.target.value)} />
          </Field>
        </FieldGrid>
      )}
      <div className="grid gap-4 border-t border-divider pt-4 md:grid-cols-2">
        <Field label={t("serviceAdvanced.deploy.mode")} hint={t(`serviceAdvanced.deploy.${mode}Hint`)}>
          <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
            <SelectTrigger aria-label={t("serviceAdvanced.deploy.mode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rolling">{t("serviceAdvanced.deploy.rolling")}</SelectItem>
              <SelectItem value="recreate">{t("serviceAdvanced.deploy.recreate")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("serviceAdvanced.deploy.healthTimeout")} htmlFor="d-ht" hint={t("serviceAdvanced.deploy.healthTimeoutHint")}>
          <Input id="d-ht" inputMode="numeric" value={healthTimeout} onChange={(e) => setHealthTimeout(e.target.value)} />
        </Field>
      </div>
    </SectionCard>
  );
}

function CrashCard({ service }: { service: ServiceDetail }) {
  const [restart, setRestart] = useState(service.crashPolicy.restart);
  const [stopAfter, setStopAfter] = useState(String(service.crashPolicy.stopAfterCrashes));
  const save = useOpMutation(services.setCrashPolicy, { onSuccess: useSaved() });
  return (
    <SectionCard
      title={t("serviceAdvanced.crash.title")}
      description={t("serviceAdvanced.crash.description", { seconds: service.restartDelaySeconds })}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ serviceId: service.id, restart, stopAfterCrashes: restart ? (parseIntOrNull(stopAfter) ?? 0) : 0 })
            }
          >
            {t("service.save")}
          </Button>
          <span>{t("serviceAdvanced.crash.appliesNow")}</span>
          <MutationError error={save.error} />
        </>
      }
    >
      <ToggleRow
        title={t("serviceAdvanced.crash.restart")}
        description={t("serviceAdvanced.crash.restartHint", { seconds: service.restartDelaySeconds })}
        control={<Switch checked={restart} onCheckedChange={setRestart} aria-label={t("serviceAdvanced.crash.restart")} />}
      />
      {restart && (
        <Field
          label={t("serviceAdvanced.crash.stopAfter")}
          htmlFor="c-stop"
          hint={t("serviceAdvanced.crash.stopAfterHint")}
          className="max-w-xs"
        >
          <Input id="c-stop" inputMode="numeric" value={stopAfter} onChange={(e) => setStopAfter(e.target.value)} />
        </Field>
      )}
    </SectionCard>
  );
}

type PlacementRow = { nodeId: string; replicas: string };
/** Select value for "no entry node set": Radix refuses an empty item value. */
const firstEntry = "first";

function PlacementCard({ service }: { service: ServiceDetail }) {
  const nodes = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  const [rows, setRows] = useState<PlacementRow[]>(service.placements.map((p) => ({ nodeId: p.nodeId, replicas: String(p.replicas) })));
  const [sticky, setSticky] = useState(service.stickySessions);
  const [entry, setEntry] = useState<string | null>(service.entryNodeId);
  const save = useOpMutation(services.setPlacements, { onSuccess: useSaved() });
  const hasVolumes = volumesOf(service).length > 0;
  const all =
    nodes.data?.nodes ?? service.placements.map((p) => ({ id: p.nodeId, name: p.nodeName, online: true, canBuild: false, queued: 0 }));
  const free = all.filter((n) => !rows.some((r) => r.nodeId === n.id));
  const total = rows.reduce((sum, r) => sum + (parseIntOrNull(r.replicas) ?? 1), 0);
  // The entry node must be one of the rows; when it is gone the panel falls back to the first one.
  const entryNodeId = rows.length > 1 && entry && rows.some((r) => r.nodeId === entry) ? entry : null;
  const nodeName = (id: string) => all.find((n) => n.id === id)?.name ?? id;

  return (
    <SectionCard
      title={t("serviceAdvanced.placement.title")}
      description={t("serviceAdvanced.placement.description")}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={save.isPending || rows.length === 0}
            onClick={() =>
              save.mutate({
                serviceId: service.id,
                placements: rows.map((r) => ({ nodeId: r.nodeId, replicas: Math.min(32, Math.max(1, parseIntOrNull(r.replicas) ?? 1)) })),
                stickySessions: sticky,
                entryNodeId,
              })
            }
          >
            {t("service.save")}
          </Button>
          <span>{t("serviceAdvanced.placement.deploysNow", { count: total })}</span>
          <MutationError error={save.error} />
        </>
      }
    >
      {rows.map((r, i) => (
        <div key={r.nodeId} className="flex items-end gap-2">
          <Field label={i === 0 ? t("serviceAdvanced.placement.node") : ""} className="flex-1">
            <Select value={r.nodeId} onValueChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, nodeId: v } : x)))}>
              <SelectTrigger aria-label={t("serviceAdvanced.placement.node")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {all
                  .filter((n) => n.id === r.nodeId || !rows.some((x) => x.nodeId === n.id))
                  .map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                      {!n.online ? ` · ${t("serviceSource.build.offline")}` : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={i === 0 ? t("serviceAdvanced.placement.replicas") : ""} className="w-28">
            <Input
              inputMode="numeric"
              aria-label={t("serviceAdvanced.placement.replicas")}
              value={r.replicas}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, replicas: e.target.value } : x)))}
            />
          </Field>
          <Button
            size="icon"
            variant="ghost"
            className="size-[38px]"
            disabled={rows.length === 1}
            aria-label={t("service.remove")}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            <IconTrash size={15} />
          </Button>
        </div>
      ))}
      {hasVolumes ? (
        <Callout tone="neutral">{t("serviceAdvanced.placement.volumes")}</Callout>
      ) : (
        free.length > 0 && (
          <Button size="sm" className="self-start" onClick={() => setRows([...rows, { nodeId: free[0]?.id ?? "", replicas: "1" }])}>
            <IconPlus size={14} />
            {t("serviceAdvanced.placement.addNode")}
          </Button>
        )
      )}
      {rows.length > 1 && (
        <Field label={t("serviceAdvanced.placement.entry")} hint={t("serviceAdvanced.placement.entryHint")} className="max-w-sm">
          <Select value={entryNodeId ?? firstEntry} onValueChange={(v) => setEntry(v === firstEntry ? null : v)}>
            <SelectTrigger aria-label={t("serviceAdvanced.placement.entry")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={firstEntry}>
                {t("serviceAdvanced.placement.entryFirst", { name: nodeName(rows[0]?.nodeId ?? "") })}
              </SelectItem>
              {rows.slice(1).map((r) => (
                <SelectItem key={r.nodeId} value={r.nodeId}>
                  {nodeName(r.nodeId)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <ToggleRow
        title={t("serviceAdvanced.placement.sticky")}
        description={t("serviceAdvanced.placement.stickyHint")}
        control={<Switch checked={sticky} onCheckedChange={setSticky} aria-label={t("serviceAdvanced.placement.sticky")} />}
      />
    </SectionCard>
  );
}

function MoveCard({ service }: { service: ServiceDetail }) {
  const nodes = useOp(builds.getSettings, { serviceId: service.id }, { retry: retryOp });
  const navigate = useNavigate();
  const [to, setTo] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const move = useOpMutation(services.move, {
    onSuccess: () => {
      toast.success(t("serviceEnv.moveStarted"));
      void navigate({ to: "/p/$projectId/s/$serviceId/deployments", params: { projectId: service.projectId, serviceId: service.id } });
    },
  });
  const here = new Set(service.placements.map((p) => p.nodeId));
  const options = (nodes.data?.nodes ?? []).filter((n) => !here.has(n.id));
  const target = options.find((n) => n.id === to);
  if (service.placements.length !== 1) return null;
  return (
    <SectionCard title={t("serviceAdvanced.move.title")} description={t("serviceAdvanced.move.description")}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("serviceAdvanced.move.to")} className="w-60">
          <Select value={to ?? undefined} onValueChange={setTo} disabled={options.length === 0}>
            <SelectTrigger aria-label={t("serviceAdvanced.move.to")}>
              <SelectValue placeholder={options.length ? t("serviceAdvanced.move.pick") : t("serviceAdvanced.move.noOther")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((n) => (
                <SelectItem key={n.id} value={n.id} disabled={!n.online}>
                  {n.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Button onClick={() => setConfirm(true)} disabled={!target || move.isPending}>
          {t("serviceAdvanced.move.button")}
        </Button>
        <MutationError error={move.error} />
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceAdvanced.move.confirmTitle", { name: service.name, node: target?.name ?? "" })}
        description={t("serviceAdvanced.move.confirmBody")}
        confirmLabel={t("serviceAdvanced.move.button")}
        onConfirm={() => (target ? move.mutateAsync({ serviceId: service.id, toNodeId: target.id }).then(() => undefined) : undefined)}
      />
    </SectionCard>
  );
}

function ResourcesCard({ service }: { service: ServiceDetail }) {
  const r = service.resources;
  const toMb = (v: number | null) => (v == null ? "" : String(Math.round(v / mb)));
  const [memory, setMemory] = useState(toMb(r.memoryLimitBytes));
  const [reservation, setReservation] = useState(toMb(r.memoryReservationBytes));
  const [weight, setWeight] = useState(r.cpuWeight == null ? "" : String(r.cpuWeight));
  const [pids, setPids] = useState(r.pidsLimit == null ? "" : String(r.pidsLimit));
  const save = useOpMutation(services.setResources, { onSuccess: useSaved() });
  const bytes = (s: string) => {
    const n = parseIntOrNull(s);
    return n == null ? null : n * mb;
  };
  return (
    <SectionCard
      title={t("serviceAdvanced.resources.title")}
      description={t("serviceAdvanced.resources.description")}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                serviceId: service.id,
                memoryLimitBytes: bytes(memory),
                memoryReservationBytes: bytes(reservation),
                cpuWeight: parseIntOrNull(weight),
                pidsLimit: parseIntOrNull(pids),
              })
            }
          >
            {t("service.save")}
          </Button>
          <span>{t("serviceAdvanced.nextDeploy")}</span>
          <MutationError error={save.error} />
        </>
      }
    >
      <FieldGrid className="grid-cols-2 md:grid-cols-4">
        <Field label={t("serviceAdvanced.resources.memory")} htmlFor="r-mem" hint={t("serviceAdvanced.resources.emptyOff")}>
          <Input id="r-mem" inputMode="numeric" value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="MB" />
        </Field>
        <Field label={t("serviceAdvanced.resources.reservation")} htmlFor="r-res" hint={t("serviceAdvanced.resources.emptyOff")}>
          <Input id="r-res" inputMode="numeric" value={reservation} onChange={(e) => setReservation(e.target.value)} placeholder="MB" />
        </Field>
        <Field label={t("serviceAdvanced.resources.cpuWeight")} htmlFor="r-cpu" hint={t("serviceAdvanced.resources.cpuWeightHint")}>
          <Input id="r-cpu" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="100" />
        </Field>
        <Field label={t("serviceAdvanced.resources.pids")} htmlFor="r-pids" hint={t("serviceAdvanced.resources.emptyOff")}>
          <Input id="r-pids" inputMode="numeric" value={pids} onChange={(e) => setPids(e.target.value)} />
        </Field>
      </FieldGrid>
    </SectionCard>
  );
}

type Port = ServiceDetail["ports"][number];

function ContainerCard({ service }: { service: ServiceDetail }) {
  const c = service.container;
  const [command, setCommand] = useState(joinArgs(c.command));
  const [entrypoint, setEntrypoint] = useState(joinArgs(c.entrypoint));
  const [workingDir, setWorkingDir] = useState(c.workingDir);
  const [user, setUser] = useState(c.user);
  const [stopSignal, setStopSignal] = useState(c.stopSignal);
  const [grace, setGrace] = useState(String(c.stopGraceSeconds));
  const [ports, setPorts] = useState<Port[]>(service.ports);
  const save = useOpMutation(services.update, { onSuccess: useSaved() });
  const input: OpInput<typeof services.update> = {
    serviceId: service.id,
    container: {
      command: splitArgs(command),
      entrypoint: splitArgs(entrypoint),
      workingDir: workingDir.trim(),
      user: user.trim(),
      stopSignal: stopSignal.trim().toUpperCase(),
      stopGraceSeconds: parseIntOrNull(grace) ?? 10,
    },
    ports: ports.filter((p) => p.containerPort > 0),
  };
  return (
    <SectionCard
      title={t("serviceAdvanced.container.title")}
      description={t("serviceAdvanced.container.description")}
      footer={
        <>
          <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(input)}>
            {t("service.save")}
          </Button>
          <span>{t("serviceAdvanced.nextDeploy")}</span>
          <MutationError error={save.error} />
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceAdvanced.container.command")} htmlFor="ct-cmd" hint={t("serviceAdvanced.container.emptyImage")}>
          <Input id="ct-cmd" className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} />
        </Field>
        <Field label={t("serviceAdvanced.container.entrypoint")} htmlFor="ct-ep" hint={t("serviceAdvanced.container.emptyImage")}>
          <Input id="ct-ep" className="font-mono" value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} />
        </Field>
        <Field label={t("serviceAdvanced.container.workingDir")} htmlFor="ct-wd">
          <Input id="ct-wd" className="font-mono" value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} />
        </Field>
        <Field label={t("serviceAdvanced.container.user")} htmlFor="ct-user">
          <Input id="ct-user" className="font-mono" value={user} onChange={(e) => setUser(e.target.value)} />
        </Field>
        <Field label={t("serviceAdvanced.container.stopSignal")} htmlFor="ct-sig">
          <Input
            id="ct-sig"
            className="font-mono"
            value={stopSignal}
            onChange={(e) => setStopSignal(e.target.value)}
            placeholder="SIGTERM"
          />
        </Field>
        <Field label={t("serviceAdvanced.container.grace")} htmlFor="ct-grace">
          <Input id="ct-grace" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-col gap-2 border-t border-divider pt-4">
        <span className="text-[13px] font-medium text-ink-strong">{t("serviceAdvanced.container.ports")}</span>
        <span className="text-xs text-muted-foreground">{t("serviceAdvanced.container.portsHint")}</span>
        {ports.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: unsaved form rows have no id
          <div key={`${i}-${p.protocol}`} className="flex items-center gap-2">
            <Input
              className="w-32 font-mono"
              inputMode="numeric"
              aria-label={t("serviceDomains.form.port")}
              value={p.containerPort || ""}
              onChange={(e) => setPorts(ports.map((x, j) => (j === i ? { ...x, containerPort: Number(e.target.value) || 0 } : x)))}
            />
            <Select
              value={p.protocol}
              onValueChange={(v) => setPorts(ports.map((x, j) => (j === i ? { ...x, protocol: v as Port["protocol"] } : x)))}
            >
              <SelectTrigger className="w-24" aria-label={t("serviceAdvanced.container.protocol")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              className="size-[38px]"
              aria-label={t("service.remove")}
              onClick={() => setPorts(ports.filter((_, j) => j !== i))}
            >
              <IconTrash size={15} />
            </Button>
          </div>
        ))}
        <Button size="sm" className="self-start" onClick={() => setPorts([...ports, { containerPort: 0, protocol: "tcp" }])}>
          <IconPlus size={14} />
          {t("serviceAdvanced.container.addPort")}
        </Button>
      </div>
    </SectionCard>
  );
}

function CronScheduleCard({ service }: { service: ServiceDetail }) {
  const c = service.cron;
  const [schedule, setSchedule] = useState(c?.schedule ?? "0 3 * * *");
  const [timeZone, setTimeZone] = useState(c?.timeZone ?? "UTC");
  const [command, setCommand] = useState(joinArgs(c?.command ?? []));
  const [timeout, setTimeoutSeconds] = useState(String(c?.timeoutSeconds ?? 3600));
  const [concurrency, setConcurrency] = useState(c?.concurrency ?? "forbid");
  const save = useOpMutation(services.update, { onSuccess: useSaved() });
  return (
    <SectionCard
      title={t("serviceAdvanced.cron.title")}
      description={t("serviceAdvanced.cron.description")}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                serviceId: service.id,
                cron: {
                  schedule: schedule.trim(),
                  timeZone: timeZone.trim(),
                  command: splitArgs(command),
                  timeoutSeconds: parseIntOrNull(timeout) ?? 3600,
                  concurrency,
                },
              })
            }
          >
            {t("service.save")}
          </Button>
          <MutationError error={save.error} />
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("serviceCron.schedule")} htmlFor="cs-s" hint={describeCron(schedule)}>
          <Input id="cs-s" className="font-mono" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
        </Field>
        <Field label={t("serviceCron.timeZone")} htmlFor="cs-tz">
          <Input id="cs-tz" className="font-mono" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
        </Field>
        <Field label={t("serviceCron.command")} htmlFor="cs-cmd" hint={t("serviceAdvanced.container.emptyImage")}>
          <Input id="cs-cmd" className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} />
        </Field>
        <Field label={t("serviceCron.timeout")} htmlFor="cs-to">
          <Input id="cs-to" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutSeconds(e.target.value)} />
        </Field>
        <Field label={t("serviceCron.concurrency")}>
          <Select value={concurrency} onValueChange={(v) => setConcurrency(v as typeof concurrency)}>
            <SelectTrigger aria-label={t("serviceCron.concurrency")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["forbid", "allow", "replace"] as const).map((x) => (
                <SelectItem key={x} value={x}>
                  {t(`serviceCron.concurrencyOptions.${x}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </SectionCard>
  );
}
