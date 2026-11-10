// /dev/kit: every UI kit component with sample data, for visual checks and
// screenshots. Outside the signed-in layout so it renders with no panel.
// The theme switch here is temporary (not saved).

import { presetAvatarPath, settings } from "@seylo/ops";
import { Alert } from "@seylo/ui/components/alert";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip, StatusDot } from "@seylo/ui/components/chip";
import { CodeBlock } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { DataTable, type DataTableColumn } from "@seylo/ui/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@seylo/ui/components/dropdown-menu";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Input, Label } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { LogViewer, useLogBuffer } from "@seylo/ui/components/log-viewer";
import { PageHeader } from "@seylo/ui/components/page-header";
import { Popover, PopoverContent, PopoverTrigger } from "@seylo/ui/components/popover";
import { Progress, usageTone } from "@seylo/ui/components/progress";
import { RadioCard, RadioGroup, RadioGroupItem } from "@seylo/ui/components/radio-group";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@seylo/ui/components/sheet";
import { ChartLegend, type ChartSeries, SmoothChart, toggleHidden } from "@seylo/ui/components/smooth-chart";
import { Sparkline } from "@seylo/ui/components/sparkline";
import { StatTile } from "@seylo/ui/components/stat-tile";
import { Switch } from "@seylo/ui/components/switch";
import { Textarea } from "@seylo/ui/components/textarea";
import { toast } from "@seylo/ui/components/toast";
import { Tip } from "@seylo/ui/components/tooltip";
import { IconArrowBackUp, IconPlus, IconRefresh, IconRocket, IconServer, IconTrash } from "@tabler/icons-react";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../i18n/t";

export const Route = createFileRoute("/dev/kit")({
  component: KitPage,
});

// Sample data: deterministic so screenshots compare.
function wave(n: number, base: number, amp: number, phase: number): number[] {
  return Array.from(
    { length: n },
    (_, i) => Math.round((base + amp * Math.sin(i / 3 + phase) + (amp / 3) * Math.sin(i * 1.7 + phase * 2)) * 10) / 10,
  );
}

const nodeSeries: ChartSeries[] = [
  { id: "de", label: "de-fsn-1", values: wave(30, 24, 8, 0) },
  { id: "us", label: "us-ash-1", values: wave(30, 12, 5, 1.3) },
  { id: "il", label: "il-tlv-1", values: wave(30, 62, 10, 2.1) },
];
const times = Array.from({ length: 30 }, (_, i) => `14:${String(i * 2).padStart(2, "0")}`);

interface NodeRow {
  id: string;
  name: string;
  address: string;
  cpu: number;
  memory: number;
  version: string;
  status: "ok" | "busy" | "error";
}

const nodeRows: NodeRow[] = [
  { id: "1", name: "de-fsn-1", address: "203.0.113.4", cpu: 23, memory: 39, version: "0.4.2", status: "ok" },
  { id: "2", name: "us-ash-1", address: "198.51.100.18", cpu: 12, memory: 30, version: "0.4.2", status: "ok" },
  { id: "3", name: "il-tlv-1", address: "192.0.2.200", cpu: 64, memory: 92, version: "0.4.1", status: "busy" },
];

const sampleLog = [
  "\x1b[2m#1\x1b[0m [internal] load build definition from Dockerfile",
  "\x1b[2m#2\x1b[0m [internal] load metadata for docker.io/library/node:24-alpine",
  "\x1b[34m#3\x1b[0m \x1b[1m[1/5]\x1b[0m FROM docker.io/library/node:24-alpine@sha256:4f2e...",
  "\x1b[34m#4\x1b[0m [2/5] WORKDIR /app",
  "\x1b[34m#5\x1b[0m [3/5] COPY package.json bun.lock ./",
  "\x1b[34m#6\x1b[0m [4/5] RUN bun install --frozen-lockfile",
  "\x1b[33mwarn\x1b[0m deprecated inflight@1.0.6: This module is not supported",
  "\x1b[32m+\x1b[0m 412 packages installed [3.21s]",
  "\x1b[34m#7\x1b[0m [5/5] RUN bun run build",
  "\x1b[31merror\x1b[0m TS2307: Cannot find module './env' (retrying with cache off)",
  "\x1b[32m✓\x1b[0m built in 8.4s",
  "\x1b[38;5;141mpushing\x1b[0m registry 127.0.0.1:5755/api@sha256:9c41e07",
];

function KitPage() {
  const [theme, setTheme] = useState<string>(document.documentElement.dataset.theme ?? "seylo");
  const [half, setHalf] = useState(document.documentElement.classList.contains(settings.bootDom.darkClass) ? "dark" : "light");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [builder, setBuilder] = useState("railpack");
  const [range, setRange] = useState("1h");
  const log = useLogBuffer(5000);

  useEffect(() => {
    if (log.length) return;
    const start = Date.UTC(2026, 10, 5, 14, 2, 0);
    log.pushMany(
      sampleLog.map((text, i) => ({
        text,
        ts: start + i * 1200,
        source: i < 6 ? "build" : "deploy",
        level: text.includes("error") ? "error" : undefined,
      })),
    );
  }, [log]);

  function pickTheme(next: string) {
    setTheme(next);
    document.documentElement.setAttribute(settings.bootDom.themeAttribute, next);
  }

  function pickHalf(next: string) {
    setHalf(next);
    document.documentElement.classList.toggle(settings.bootDom.darkClass, next === "dark");
  }

  const columns: DataTableColumn<NodeRow>[] = [
    {
      id: "name",
      header: t("devkit.sample.colNode"),
      sortValue: (r) => r.name,
      cell: (r) => (
        <span className="flex items-center gap-2.5 font-medium">
          <StatusDot status={r.status} />
          {r.name}
        </span>
      ),
    },
    {
      id: "address",
      header: t("devkit.sample.colAddress"),
      cell: (r) => <span className="font-mono text-[12.5px]">{r.address}</span>,
      hideOnMobile: true,
    },
    {
      id: "cpu",
      header: t("devkit.sample.colCpu"),
      sortValue: (r) => r.cpu,
      width: "160px",
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Progress value={r.cpu} tone={usageTone(r.cpu)} className="w-20" />
          <span className="tabular-nums">{r.cpu}%</span>
        </span>
      ),
    },
    { id: "memory", header: t("devkit.sample.colMemory"), sortValue: (r) => r.memory, align: "right", cell: (r) => `${r.memory}%` },
    {
      id: "version",
      header: t("devkit.sample.colVersion"),
      sortValue: (r) => r.version,
      cell: (r) => (
        <Chip tone="track" mono>
          {r.version}
        </Chip>
      ),
    },
  ];

  return (
    <main className="mx-auto box-border flex w-full max-w-[1180px] flex-col gap-5 px-4 pt-[26px] pb-16 md:px-[30px]">
      <PageHeader
        breadcrumb={<span>{t("devkit.breadcrumbRoot")}</span>}
        title={t("devkit.title")}
        subtitle={t("devkit.subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={theme} onValueChange={pickTheme}>
              <SelectTrigger aria-label={t("devkit.theme")} className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.themePresets.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Segmented aria-label={t("devkit.half")} value={half} onValueChange={pickHalf} tone="track">
              {(["light", "dark"] as const).map((mode) => (
                <SegmentedItem key={mode} value={mode}>
                  {t(`settingsAppearance.modes.${mode}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>
        }
      />

      <SectionCard title={t("devkit.sections.buttons")}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">
            <IconRocket size={15} />
            {t("devkit.sample.primary")}
          </Button>
          <Button>{t("devkit.sample.secondary")}</Button>
          <Button variant="ghost">{t("devkit.sample.ghost")}</Button>
          <Button variant="destructive">{t("devkit.sample.destructive")}</Button>
          <Button size="sm">{t("devkit.sample.secondary")}</Button>
          <Button size="icon" variant="ghost" aria-label={t("devkit.sample.restart")}>
            <IconRefresh size={16} />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="green">
            <StatusDot status="ok" pulse />
            {t("devkit.sample.running")}
          </Chip>
          <Chip tone="amber">
            <StatusDot status="busy" pulse />
            {t("devkit.sample.building")}
          </Chip>
          <Chip tone="red">{t("devkit.sample.failed")}</Chip>
          <Chip tone="gray">{t("devkit.sample.stopped")}</Chip>
          <Chip tone="blue">blue</Chip>
          <Chip tone="sky">sky</Chip>
          <Chip tone="violet">violet</Chip>
          <Chip tone="track" mono>
            de-fsn-1
          </Chip>
          <span className="ml-2 flex items-center gap-1.5">
            <Avatar name="ops@example.com" size="sm" />
            <Avatar name="Dana Levi" />
            <Avatar name="build bot" size="lg" />
            <Avatar name="Lee Park" src={presetAvatarPath("lorelei", "lee-park")} size="lg" />
            <Avatar name="Broken image" src="/api/avatars/user/none?v=0" size="lg" />
          </span>
        </div>
      </SectionCard>

      <SectionCard title={t("devkit.sections.forms")}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kit-name">{t("devkit.sample.serviceName")}</Label>
            <Input id="kit-name" placeholder={t("devkit.sample.serviceNamePlaceholder")} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("devkit.sample.node")}</Label>
            <Select defaultValue="de">
              <SelectTrigger aria-label={t("devkit.sample.node")}>
                <SelectValue placeholder={t("devkit.sample.pickNode")} />
              </SelectTrigger>
              <SelectContent>
                {nodeRows.map((n) => (
                  <SelectItem key={n.id} value={n.name.slice(0, 2)}>
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <Label htmlFor="kit-notes">{t("devkit.sample.notes")}</Label>
            <Textarea id="kit-notes" placeholder={t("devkit.sample.notesPlaceholder")} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t("devkit.sample.builder")}</Label>
          <RadioGroup
            value={builder}
            onValueChange={setBuilder}
            className="grid-cols-1 md:grid-cols-3"
            aria-label={t("devkit.sample.builder")}
          >
            <RadioCard value="railpack" title={t("devkit.sample.builderRailpack")} description={t("devkit.sample.builderRailpackHint")} />
            <RadioCard value="nixpacks" title={t("devkit.sample.builderNixpacks")} description={t("devkit.sample.builderNixpacksHint")} />
            <RadioCard
              value="dockerfile"
              title={t("devkit.sample.builderDockerfile")}
              description={t("devkit.sample.builderDockerfileHint")}
            />
          </RadioGroup>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2.5">
            <Switch defaultChecked id="kit-auto" />
            <Label htmlFor="kit-auto" className="font-normal text-foreground text-[13.5px]">
              {t("devkit.sample.autoDeploy")}
            </Label>
          </div>
          <div className="flex items-center gap-2.5">
            <Switch size="sm" id="kit-zero" />
            <Label htmlFor="kit-zero" className="font-normal text-foreground text-[13.5px]">
              {t("devkit.sample.zeroDowntime")}
            </Label>
          </div>
          <div className="flex items-center gap-2.5">
            <Checkbox defaultChecked id="kit-risk" />
            <Label htmlFor="kit-risk" className="font-normal text-foreground text-[13.5px]">
              {t("devkit.sample.acceptRisk")}
            </Label>
          </div>
          <RadioGroup defaultValue="restart" className="flex gap-4" aria-label={t("devkit.sample.restartPolicy")}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="restart" id="kit-restart" />
              <Label htmlFor="kit-restart" className="font-normal text-foreground text-[13.5px]">
                {t("devkit.sample.restartAlways")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="stop" id="kit-stop" />
              <Label htmlFor="kit-stop" className="font-normal text-foreground text-[13.5px]">
                {t("devkit.sample.restartStop")}
              </Label>
            </div>
          </RadioGroup>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <CopyField aria-label={t("devkit.sample.install")} prefix="$" value="curl -fsSL https://install.seylo.dev | sh" />
          <CopyField aria-label={t("devkit.sample.password")} secret value="v7Hq2mZ8pLw4sXc1" />
        </div>
      </SectionCard>

      <SectionCard title={t("devkit.sections.overlays")}>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>{t("devkit.sample.menu")}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>api</DropdownMenuLabel>
              <DropdownMenuItem>
                <IconRefresh size={15} />
                {t("devkit.sample.restart")}
                <DropdownMenuShortcut>R</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <IconRocket size={15} />
                {t("devkit.sample.redeploy")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive>
                <IconTrash size={15} />
                {t("devkit.sample.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button>{t("devkit.sample.popover")}</Button>
            </PopoverTrigger>
            <PopoverContent>{t("devkit.sample.popoverText")}</PopoverContent>
          </Popover>
          <Tip content={t("devkit.sample.tooltipText")}>
            <Button variant="ghost">{t("devkit.sample.tooltip")}</Button>
          </Tip>
          <Sheet>
            <SheetTrigger asChild>
              <Button>{t("devkit.sample.sheet")}</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{t("devkit.sample.sheetTitle")}</SheetTitle>
                <SheetDescription>{t("devkit.sample.sheetText")}</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <Input defaultValue="api.example.com" aria-label={t("devkit.sample.sheetTitle")} />
              </SheetBody>
              <SheetFooter>
                <Button variant="primary">{t("devkit.sample.primary")}</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            {t("devkit.sample.confirm")}
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            destructive
            title={t("devkit.sample.confirmTitle")}
            description={t("devkit.sample.confirmText")}
            confirmLabel={t("devkit.sample.delete")}
            confirmText="api"
            onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
          />
        </div>
      </SectionCard>

      <SectionCard title={t("devkit.sections.feedback")}>
        <Alert tone="info">{t("devkit.sample.alertInfo")}</Alert>
        <Alert tone="success">{t("devkit.sample.alertSuccess")}</Alert>
        <Alert tone="warning" title={t("devkit.sample.alertTitle")} action={<Button size="sm">{t("devkit.sample.viewLogs")}</Button>}>
          {t("devkit.sample.alertWarning")}
        </Alert>
        <Alert tone="danger">{t("devkit.sample.alertDanger")}</Alert>
        <div className="grid gap-3 md:grid-cols-4">
          <Progress value={23} tone={usageTone(23)} />
          <Progress value={78} tone={usageTone(78)} />
          <Progress value={94} tone={usageTone(94)} />
          <Progress value={null} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => toast.success(t("devkit.sample.toastSaved"))}>{t("devkit.sample.toastSuccess")}</Button>
          <Button
            onClick={() =>
              toast.error(t("devkit.sample.toastFailed"), {
                description: t("devkit.sample.toastFailedDetail"),
                action: { label: t("devkit.sample.viewLogs"), onClick: () => {} },
              })
            }
          >
            {t("devkit.sample.toastError")}
          </Button>
          <Button onClick={() => toast(t("devkit.sample.toastCopied"))}>{t("devkit.sample.toastPlain")}</Button>
        </div>
      </SectionCard>

      <section aria-label={t("devkit.sections.data")} className="flex flex-col gap-3">
        <h2 className="m-0 text-[15px] font-semibold">{t("devkit.sections.data")}</h2>
        <DataTable
          aria-label={t("devkit.sample.nodes")}
          columns={columns}
          rows={nodeRows}
          getRowId={(r) => r.id}
          initialSort={{ id: "name", desc: false }}
          minWidth={640}
          rowActions={() => [
            { label: t("devkit.sample.restart"), icon: <IconRefresh size={15} />, onSelect: () => {} },
            { label: t("devkit.sample.rollback"), icon: <IconArrowBackUp size={15} />, onSelect: () => {} },
            { label: t("devkit.sample.delete"), icon: <IconTrash size={15} />, onSelect: () => {}, destructive: true, separated: true },
          ]}
        />
        <DataTable
          aria-label={t("devkit.sample.nodes")}
          columns={columns}
          rows={[]}
          getRowId={(r) => r.id}
          empty={
            <EmptyState
              compact
              icon={<IconServer />}
              title={t("devkit.sample.noNodes")}
              description={t("devkit.sample.noNodesHint")}
              action={
                <Button variant="primary" size="sm">
                  <IconPlus size={14} />
                  {t("devkit.sample.addNode")}
                </Button>
              }
            />
          }
        />
        <div className="grid gap-5 md:grid-cols-2">
          <SectionCard title={t("devkit.sample.details")}>
            <KeyValue
              items={[
                { label: t("devkit.sample.image"), value: "ghcr.io/acme/api@sha256:9c41e07", mono: true },
                { label: t("devkit.sample.node"), value: <Chip tone="track">de-fsn-1</Chip> },
                { label: t("devkit.sample.created"), value: "2026-11-05 14:02" },
              ]}
            />
          </SectionCard>
          <SectionCard title={t("devkit.sample.composeFile")}>
            <KeyValue
              layout="grid"
              items={[
                { label: t("devkit.sample.region"), value: "Falkenstein" },
                { label: t("devkit.sample.cpu"), value: "4 vCPU" },
                { label: t("devkit.sample.memory"), value: "16 GB" },
                { label: t("devkit.sample.colVersion"), value: "0.4.2", mono: true },
              ]}
            />
            <CodeBlock
              title={t("devkit.sample.composeFile")}
              code={"services:\n  api:\n    image: ghcr.io/acme/api:latest\n    ports:\n      - 3000"}
            />
            <CodeBlock tone="dark" code="seylo logs api --follow" />
          </SectionCard>
        </div>
      </section>

      <SectionCard
        title={t("devkit.sections.charts")}
        actions={
          <>
            <ChartLegend series={nodeSeries} hidden={hidden} onToggle={(id) => setHidden(toggleHidden(hidden, id))} />
            <Segmented aria-label={t("devkit.theme")} value={range} onValueChange={setRange}>
              {["1h", "24h", "7d"].map((r) => (
                <SegmentedItem key={r} value={r}>
                  {r}
                </SegmentedItem>
              ))}
            </Segmented>
          </>
        }
      >
        <div className="grid gap-[22px] md:grid-cols-2">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium text-ink-strong">{t("devkit.sample.cpu")}</span>
              <span className="text-[12px] text-muted-foreground">{t("devkit.sample.cpuHint")}</span>
            </div>
            <SmoothChart
              aria-label={t("devkit.sample.cpu")}
              series={nodeSeries}
              labels={times}
              hidden={hidden}
              max={100}
              formatValue={(v) => `${v}%`}
            />
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium text-ink-strong">{t("devkit.sample.memory")}</span>
            </div>
            <SmoothChart
              aria-label={t("devkit.sample.memory")}
              series={nodeSeries.map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : v * 0.8 + 5)) }))}
              labels={times}
              hidden={hidden}
              legend
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={t("devkit.sample.cpu")}
            value="23"
            unit="%"
            delta={{ value: "-4%", tone: "good" }}
            spark={nodeSeries[0]?.values}
          />
          <StatTile
            label={t("devkit.sample.memory")}
            value="6.2"
            unit="/ 16 GB"
            hint="de-fsn-1"
            spark={nodeSeries[2]?.values}
            sparkColor="var(--chart-2)"
          />
          <StatTile label={t("devkit.sample.requests")} value="18.4k" delta={{ value: "+12%", tone: "neutral" }} />
          <StatTile label={t("devkit.sample.uptime")} value="99.98" unit="%" hint={t("devkit.sample.last30")} />
        </div>
        <div className="w-40">
          <Sparkline values={nodeSeries[1]?.values ?? []} aria-label={t("devkit.sample.requests")} />
        </div>
      </SectionCard>

      <section aria-label={t("devkit.sections.logs")} className="flex flex-col gap-3">
        <h2 className="m-0 text-[15px] font-semibold">{t("devkit.sections.logs")}</h2>
        <LogViewer
          aria-label={t("devkit.sample.buildLog")}
          buffer={log}
          height={340}
          showTimestamps
          showSource
          title={
            <>
              <span>{t("devkit.sample.buildLog")}</span>
              <span className="font-mono text-[12px] font-normal text-terminal-muted">9c41e07</span>
            </>
          }
          actions={
            <>
              <Button
                size="sm"
                variant="ghost"
                className="text-terminal-muted hover:bg-terminal-field hover:text-terminal-foreground"
                onClick={() => {
                  const now = Date.now();
                  log.pushMany(
                    Array.from({ length: 2000 }, (_, i) => ({
                      text: `\x1b[36mGET\x1b[0m /api/health 200 ${i % 50}ms`,
                      ts: now + i,
                      source: `r${i % 3}`,
                    })),
                  );
                }}
              >
                {t("devkit.sample.addLines")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-terminal-muted hover:bg-terminal-field hover:text-terminal-foreground"
                onClick={() => log.clear()}
              >
                {t("devkit.sample.clear")}
              </Button>
            </>
          }
        />
      </section>

      <SectionCard title={t("devkit.sections.empty")} flush>
        <EmptyState
          icon={<IconRocket />}
          title={t("devkit.sample.emptyTitle")}
          description={t("devkit.sample.emptyText")}
          action={
            <Button variant="primary">
              <IconPlus size={15} />
              {t("devkit.sample.newService")}
            </Button>
          }
        />
      </SectionCard>
    </main>
  );
}
