// The node's DNS cache for containers in the node's settings (added in
// 0.2.17): the switch (nodes.setDnsCache), shown disabled with the version
// it needs when the node's agent is older, and while the cache is on or
// still used its state (nodes.dnsCacheStatus, read every 10 seconds):
// address, hit rate, upstream lookups per minute, what to fix when it is
// blocked, and the running containers that use it and those that get it
// at their next redeploy (the services' own Redeploy; nothing is recreated
// in bulk). Next to Wings it says game servers take their DNS from Wings.

import { nodes, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Chip } from "@seylo/ui/components/chip";
import { Switch } from "@seylo/ui/components/switch";
import { toast } from "@seylo/ui/components/toast";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { type MessageKey, t } from "../../i18n/t";
import { errorMessage, queryClient } from "../../lib/api";
import { formatPercent } from "../../lib/format";
import type { NodeDetail } from "../../lib/types";

type Status = OpOutput<typeof nodes.dnsCacheStatus>;
type State = Status["state"];

const stateTone: Record<State, "green" | "blue" | "red" | "amber" | "gray"> = {
  active: "green",
  starting: "blue",
  blocked: "red",
  draining: "amber",
  off: "gray",
  unknown: "gray",
};

const kindKeys: Record<string, MessageKey> = {
  service: "nodeDnsCache.kind.service",
  cron: "nodeDnsCache.kind.cron",
  backup: "nodeDnsCache.kind.backup",
  "db-ui": "nodeDnsCache.kind.dbUi",
  box: "nodeDnsCache.kind.box",
  cloudflared: "nodeDnsCache.kind.cloudflared",
};

/** How often the status is read while the settings are open. */
const pollMs = 10_000;

export function DnsCacheSetting({ node }: { node: NodeDetail }) {
  const [error, setError] = useState<unknown>(null);
  const set = useOpMutation(nodes.setDnsCache, {
    onSuccess: () => {
      setError(null);
      toast.success(t("nodes.form.saved"));
      void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.get, { nodeId: node.id }) });
      void queryClient.invalidateQueries({ queryKey: opQueryKey(nodes.dnsCacheStatus, { nodeId: node.id }) });
    },
    onError: setError,
  });
  const supported = node.dnsCacheSupported;
  const status = useOp(
    nodes.dnsCacheStatus,
    { nodeId: node.id },
    { enabled: supported && node.status === "online", retry: false, refetchInterval: pollMs },
  );
  const data = status.data;
  // Off and unused: nothing more to show. Off and still used: draining.
  const showStatus = supported && (node.dnsCache || (data !== undefined && data.state !== "off" && data.state !== "unknown"));

  return (
    <div className="flex flex-col gap-2" data-testid="dns-cache">
      <label htmlFor="toggle-dns-cache" className="flex items-start gap-3">
        <Switch
          id="toggle-dns-cache"
          checked={supported && node.dnsCache}
          disabled={!supported || set.isPending}
          onCheckedChange={(enabled) => set.mutate({ nodeId: node.id, enabled })}
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-medium">{t("nodeDnsCache.title")}</span>
          <span className="text-[12.5px] text-muted-foreground">{t("nodeDnsCache.hint")}</span>
          {!supported && (
            <span className="text-[12.5px] text-chip-amber-fg">{t("nodeDnsCache.oldAgent", { version: nodes.dnsCacheMinAgent })}</span>
          )}
          {supported && node.wings.detected && <span className="text-[12.5px] text-muted-foreground">{t("nodeDnsCache.wings")}</span>}
        </span>
      </label>
      {error !== null && <Alert tone="danger">{errorMessage(error, t("common.unknownError"))}</Alert>}
      {showStatus && <DnsCacheStatusView node={node} status={data} offline={node.status !== "online"} />}
    </div>
  );
}

function DnsCacheStatusView({ node, status, offline }: { node: NodeDetail; status: Status | undefined; offline: boolean }) {
  if (offline) return <p className="m-0 pl-11 text-[12.5px] text-muted-foreground">{t("nodeDnsCache.offline")}</p>;
  if (!status) return null;
  const state = status.state;
  const using = status.containers.filter((c) => c.usesCache);
  const waiting = status.containers.filter((c) => !c.usesCache);
  const projectOf = new Map(node.services.map((s) => [s.serviceId, s.projectId]));
  return (
    <div className="ml-11 flex flex-col gap-3 rounded-card bg-raised p-3 text-[12.5px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Chip tone={stateTone[state]} data-testid="dns-cache-state">
          {t(`nodeDnsCache.state.${state}`)}
        </Chip>
        {status.address && <Stat label={t("nodeDnsCache.address")} value={<span className="font-mono">{status.address}</span>} />}
        <Stat
          label={t("nodeDnsCache.hitRate")}
          value={status.hitRate === null ? t("nodeDnsCache.noQueries") : formatPercent(status.hitRate * 100)}
          testId="dns-cache-hit-rate"
        />
        <Stat label={t("nodeDnsCache.upstreamPerMinute")} value={String(status.upstreamPerMinute)} testId="dns-cache-upstream" />
      </div>
      {(state === "starting" || state === "draining") && (
        <p className="m-0 text-muted-foreground">{t(`nodeDnsCache.stateHint.${state}`)}</p>
      )}
      {state === "blocked" && (
        <Alert tone="warning">
          <span className="flex flex-col gap-1">
            <span>{sentence(status.reason)}</span>
            {status.fixHint && (
              <span>
                <span className="font-medium">{t("nodeDnsCache.fix")}: </span>
                <CodeText text={status.fixHint} />
              </span>
            )}
          </span>
        </Alert>
      )}
      {(status.upstreams.length > 0 || status.fallbacks.length > 0) && (
        <p className="m-0 text-muted-foreground">
          {t("nodeDnsCache.upstreams")}: <span className="font-mono">{status.upstreams.join(", ")}</span> · {t("nodeDnsCache.fallbacks")}:{" "}
          <span className="font-mono">{status.fallbacks.join(", ")}</span>
        </p>
      )}
      <ContainerList
        title={t(state === "draining" ? "nodeDnsCache.stillUsing" : "nodeDnsCache.using")}
        empty={t("nodeDnsCache.noneUsing")}
        list={using}
        projectOf={projectOf}
        testId="dns-cache-using"
      />
      {state !== "draining" && (
        <>
          <ContainerList
            title={t("nodeDnsCache.notYet")}
            empty={t("nodeDnsCache.noneWaiting")}
            list={waiting}
            projectOf={projectOf}
            testId="dns-cache-waiting"
          />
          {waiting.length > 0 && <p className="m-0 text-muted-foreground">{t("nodeDnsCache.applies")}</p>}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium" data-testid={testId}>
        {value}
      </span>
    </span>
  );
}

function ContainerList({
  title,
  empty,
  list,
  projectOf,
  testId,
}: {
  title: string;
  empty: string;
  list: Status["containers"];
  projectOf: Map<string, string>;
  testId: string;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1" data-testid={testId}>
      <h4 className="m-0 text-[12.5px] font-semibold">
        {title} <span className="font-normal text-muted-foreground">{list.length}</span>
      </h4>
      {list.length === 0 ? (
        <p className="m-0 text-muted-foreground">{empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {list.map((c) => {
            const projectId = c.serviceId ? projectOf.get(c.serviceId) : undefined;
            return (
              <li key={c.name} className="flex items-center gap-2 border-t border-divider py-1.5">
                {projectId && c.serviceId ? (
                  <Link to="/p/$projectId/s/$serviceId" params={{ projectId, serviceId: c.serviceId }} className="font-medium">
                    {c.serviceName ?? c.serviceId}
                  </Link>
                ) : (
                  c.serviceName && <span className="font-medium">{c.serviceName}</span>
                )}
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">{c.name}</span>
                <Chip tone="gray" className="ml-auto">
                  {kindKeys[c.kind] ? t(kindKeys[c.kind] as MessageKey) : c.kind}
                </Chip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The agent's reason as a sentence: a capital first letter. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Text with `code` spans (the agent's fix hints name commands that way). */
function CodeText({ text }: { text: string }) {
  const segments: { at: number; text: string; code: boolean }[] = [];
  let at = 0;
  for (const [n, part] of text.split("`").entries()) {
    segments.push({ at, text: part, code: n % 2 === 1 });
    at += part.length + 1;
  }
  return (
    <>
      {segments.map((segment) =>
        segment.code ? (
          <code key={segment.at} className="rounded-chip bg-muted px-1 py-px font-mono text-[11.5px] text-ink-strong">
            {segment.text}
          </code>
        ) : (
          <Fragment key={segment.at}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}
