// The Logs tab: a live tail over the logs WebSocket (history first, then
// new lines), kept in a 100,000-line ring outside React and drawn by the
// virtualized LogViewer. Searching asks the nodes (logs.search) across
// every deploy and shows the matches instead of the tail. Generation
// changes show as a line, so a deploy is visible in the stream.

import { logs, type OpOutput } from "@seylo/ops";
import { useOpClient } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { LogBuffer, LogViewer } from "@seylo/ui/components/log-viewer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { cn } from "@seylo/ui/lib/utils";
import { IconDownload, IconPlayerPause, IconPlayerPlay, IconSearch, IconTrash, IconX } from "@tabler/icons-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { errorMessage } from "../../../lib/api";
import { bufferText, downloadText } from "../deploy-log";
import { formatTimeOfDay } from "../format";
import { isNotBuilt } from "../op-state";
import { backoffMs, openSocket } from "../socket";
import type { ServiceDetail } from "../use-service";
import { entryToLine, GenerationTracker } from "./log-lines";

type LogEntry = OpOutput<typeof logs.search>["entries"][number];
const allNodes = "__all__";
const capacity = 100_000;

export function LogsPage({ service }: { service: ServiceDetail }) {
  const live = useMemo(() => new LogBuffer(capacity), []);
  const results = useMemo(() => new LogBuffer(capacity), []);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [search, setSearch] = useState<{ query: string; regex: boolean } | null>(null);
  const [paused, setPaused] = useState(false);
  const status = useLiveTail(service.id, nodeId, live, paused);
  const searchState = useSearch(service.id, nodeId, search, results);
  const buffer = search ? results : live;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    setSearch(q ? { query: q, regex } : null);
  };

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <IconSearch
            size={15}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
            aria-hidden="true"
          />
          <Input
            className="pl-9 font-mono text-[13px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("serviceLogs.searchPlaceholder")}
            aria-label={t("serviceLogs.search")}
          />
        </div>
        <Button
          size="sm"
          className={cn("h-[38px]", regex && "bg-chip-blue-bg text-chip-blue-fg")}
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
          title={t("serviceLogs.regexHint")}
        >
          .*
        </Button>
        <Button type="submit" variant="primary" className="h-[38px]">
          {t("serviceLogs.searchAll")}
        </Button>
        {service.placements.length > 1 && (
          <Select value={nodeId ?? allNodes} onValueChange={(v) => setNodeId(v === allNodes ? null : v)}>
            <SelectTrigger className="w-44" aria-label={t("serviceLogs.node")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allNodes}>{t("serviceLogs.allNodes")}</SelectItem>
              {service.placements.map((p) => (
                <SelectItem key={p.nodeId} value={p.nodeId}>
                  {p.nodeName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </form>
      {search && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-strong">
          <span>
            {searchState.loading ? t("serviceLogs.searching") : t("serviceLogs.matches", { count: searchState.count, query: search.query })}
          </span>
          {searchState.offline > 0 && (
            <span className="text-chip-amber-fg">{t("serviceLogs.offlineNodes", { count: searchState.offline })}</span>
          )}
          {searchState.error != null && (
            <span className="text-chip-red-fg">
              {isNotBuilt(searchState.error) ? t("service.notBuilt.title") : errorMessage(searchState.error, t("service.loadFailed"))}
            </span>
          )}
          {searchState.more && (
            <Button size="sm" onClick={searchState.loadMore}>
              {t("serviceLogs.older")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSearch(null)}>
            <IconX size={14} />
            {t("serviceLogs.backToLive")}
          </Button>
        </div>
      )}
      <LogViewer
        key={search ? "search" : "live"}
        buffer={buffer}
        aria-label={t("service.tabs.logs")}
        title={
          <span className="flex items-center gap-2.5">
            {search ? t("serviceLogs.results") : t("serviceLogs.live")}
            {!search && <LiveDot status={status} paused={paused} />}
          </span>
        }
        actions={
          <span className="flex items-center gap-0.5">
            {!search && (
              <ViewerButton
                label={paused ? t("serviceTerminal.resume") : t("serviceTerminal.pause")}
                onClick={() => setPaused((p) => !p)}
                pressed={paused}
              >
                {paused ? <IconPlayerPlay size={15} stroke={1.8} /> : <IconPlayerPause size={15} stroke={1.8} />}
              </ViewerButton>
            )}
            <ViewerButton label={t("serviceTerminal.download")} onClick={() => downloadText(`${service.name}.log`, bufferText(buffer))}>
              <IconDownload size={15} stroke={1.8} />
            </ViewerButton>
            <ViewerButton label={t("serviceTerminal.clear")} onClick={() => buffer.clear()}>
              <IconTrash size={15} stroke={1.8} />
            </ViewerButton>
          </span>
        }
        showTimestamps
        showSource
        formatTime={(ts) => formatTimeOfDay(ts)}
        height="calc(100dvh - 330px)"
        initialFollow={!search}
        empty={<span className="text-terminal-muted">{emptyText(search ? searchState : status)}</span>}
      />
    </div>
  );
}

function ViewerButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="flex cursor-pointer rounded-chip border-0 bg-transparent p-[7px] text-terminal-muted hover:text-terminal-foreground aria-pressed:text-terminal-foreground"
    >
      {children}
    </button>
  );
}

type TailStatus = { state: "connecting" | "live" | "ended" | "error"; error: unknown; reason: string };

function emptyText(s: TailStatus | SearchState): string {
  if ("state" in s) {
    if (s.state === "error") return isNotBuilt(s.error) ? t("service.notBuilt.title") : errorMessage(s.error, t("service.loadFailed"));
    if (s.state === "connecting") return t("serviceLogs.connecting");
    return t("serviceLogs.noLines");
  }
  return s.loading ? t("serviceLogs.searching") : t("serviceLogs.noMatches");
}

function LiveDot({ status, paused }: { status: TailStatus; paused: boolean }) {
  const label = paused ? t("serviceLogs.paused") : t(`serviceLogs.state.${status.state}`);
  const dot = paused
    ? "bg-status-off"
    : status.state === "live"
      ? "bg-status-ok animate-pulse"
      : status.state === "error"
        ? "bg-status-error"
        : "bg-status-busy";
  return (
    <span className="flex items-center gap-1.5 text-xs font-normal text-terminal-muted">
      <span className={cn("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

/** Follows the service's logs into buffer, reconnecting with backoff and resuming after the last line it saw. */
function useLiveTail(serviceId: string, nodeId: string | null, buffer: LogBuffer, paused: boolean): TailStatus {
  const client = useOpClient();
  const [status, setStatus] = useState<TailStatus>({ state: "connecting", error: null, reason: "" });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    buffer.clear();
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastTime: string | undefined;
    const generations = new GenerationTracker();
    const held: LogEntry[] = [];

    const push = (entries: readonly LogEntry[]) => {
      if (pausedRef.current) {
        held.push(...entries);
        if (held.length > capacity) held.splice(0, held.length - capacity);
        return;
      }
      if (held.length) buffer.pushMany(held.splice(0).flatMap((e) => generations.lines(e, entryToLine)));
      buffer.pushMany(entries.flatMap((e) => generations.lines(e, entryToLine)));
    };
    const flushHeld = setInterval(() => {
      if (!pausedRef.current && held.length) push([]);
    }, 250);

    const connect = async () => {
      setStatus((s) => ({ ...s, state: "connecting" }));
      try {
        const ticket = await client.call(logs.follow, {
          serviceId,
          ...(nodeId ? { nodeId } : {}),
          ...(lastTime ? { since: lastTime, tail: 0 } : { tail: 1000 }),
        });
        if (stopped) return;
        ws = openSocket(ticket.url);
        ws.onopen = () => {
          attempt = 0;
          setStatus({ state: "live", error: null, reason: "" });
        };
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as logs.LogsSocketMessage;
          if (message.type === "entries") {
            const last = message.entries[message.entries.length - 1];
            if (last) lastTime = last.time;
            push(message.entries);
          } else if (message.type === "node") {
            buffer.push({
              text: t(message.online ? "serviceLogs.nodeBack" : "serviceLogs.nodeGone"),
              ts: Date.now(),
              level: "system",
              source: "panel",
            });
          } else if (message.type === "end") {
            setStatus({ state: "ended", error: null, reason: message.reason });
            buffer.push({ text: message.reason, ts: Date.now(), level: "system", source: "panel" });
          }
        };
        ws.onclose = () => {
          if (stopped) return;
          timer = setTimeout(() => void connect(), backoffMs(attempt++));
        };
      } catch (error) {
        if (stopped) return;
        setStatus({ state: "error", error, reason: "" });
        // Unbuilt or forbidden: do not hammer the panel.
        if (!isNotBuilt(error)) timer = setTimeout(() => void connect(), backoffMs(attempt++));
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(flushHeld);
      ws?.close();
    };
  }, [client, serviceId, nodeId, buffer]);

  return status;
}

interface SearchState {
  loading: boolean;
  count: number;
  more: boolean;
  offline: number;
  error: unknown;
  loadMore: () => void;
}

/** Runs logs.search page by page into buffer, oldest match first. */
function useSearch(
  serviceId: string,
  nodeId: string | null,
  search: { query: string; regex: boolean } | null,
  buffer: LogBuffer,
): SearchState {
  const client = useOpClient();
  const [state, setState] = useState({ loading: false, count: 0, cursor: null as string | null, offline: 0, error: null as unknown });
  const entries = useRef<LogEntry[]>([]);
  const [page, setPage] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search resets paging.
  useEffect(() => setPage(null), [search, nodeId]);

  useEffect(() => {
    if (!search) return;
    let cancelled = false;
    if (page === null) {
      entries.current = [];
      buffer.clear();
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    client
      .call(logs.search, {
        serviceId,
        query: search.query,
        regex: search.regex,
        limit: 1000,
        ...(nodeId ? { nodeId } : {}),
        ...(page ? { cursor: page } : {}),
      })
      .then(
        (res) => {
          if (cancelled) return;
          // Results come newest first; the viewer reads oldest first.
          entries.current = [...res.entries].reverse().concat(entries.current);
          const generations = new GenerationTracker();
          buffer.clear();
          buffer.pushMany(entries.current.flatMap((e) => generations.lines(e, entryToLine)));
          setState({
            loading: false,
            count: entries.current.length,
            cursor: res.nextCursor,
            offline: res.offlineNodeIds.length,
            error: null,
          });
        },
        (error) => !cancelled && setState((s) => ({ ...s, loading: false, error })),
      );
    return () => {
      cancelled = true;
    };
  }, [client, serviceId, nodeId, search, page, buffer]);

  return {
    loading: state.loading,
    count: state.count,
    more: state.cursor !== null,
    offline: state.offline,
    error: state.error,
    loadMore: () => state.cursor && setPage(state.cursor),
  };
}
