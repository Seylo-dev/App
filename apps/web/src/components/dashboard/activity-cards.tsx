// The two cards under the projects on the dashboard (Main.dc.html):
// recent deploys (deployments.recent, failed ones included) and alerts
// (alerts.list).

import { alerts, deployments } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { Tip } from "@seylo/ui/components/tooltip";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { formatAgo } from "../../lib/format";
import { QueryError } from "../query-error";
import { isPanelImage } from "../service/deployment-meta";
import { formatDateTime } from "../settings/format";

type Tone = "ok" | "run" | "bad" | "info";

const toneClasses: Record<Tone, { ring: string; dot: string }> = {
  ok: { ring: "bg-chip-green-bg", dot: "bg-status-ok" },
  run: { ring: "bg-chip-amber-bg", dot: "bg-status-busy" },
  bad: { ring: "bg-chip-red-bg", dot: "bg-status-error" },
  info: { ring: "bg-chip-blue-bg", dot: "bg-primary" },
};

const maxRows = 5;

type Recent = (typeof deployments.RecentDeployment)["static"];

export function RecentDeploys() {
  const list = useOp(deployments.recent, { limit: maxRows });
  return (
    <FeedCard title={t("dashboard.recentDeploys")} link={<Link to="/activity">{t("dashboard.allDeploys")}</Link>}>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} className="mt-1 mb-2.5" />
      ) : list.isPending ? (
        <FeedSkeleton />
      ) : list.data.deployments.length === 0 ? (
        <Empty>{t("dashboard.noDeploys")}</Empty>
      ) : (
        list.data.deployments.map((d) => {
          const { tone, text } = deployLine(d);
          const active = d.status === "queued" || d.status === "building" || d.status === "deploying";
          return (
            <FeedRow
              key={d.id}
              tone={tone}
              title={
                <Link
                  to="/p/$projectId/s/$serviceId/deployments"
                  params={{ projectId: d.projectId, serviceId: d.serviceId }}
                  className="text-foreground hover:text-foreground"
                >
                  {d.serviceName}
                </Link>
              }
              text={text}
              when={active ? t("format.justNow") : formatAgo(d.finishedAt ?? d.createdAt)}
              exact={formatDateTime(d.finishedAt ?? d.createdAt)}
            />
          );
        })
      )}
    </FeedCard>
  );
}

/** A short version: the commit, a pulled image's tag, else the generation (never the panel registry's tag, which is the generation). */
function versionLabel(d: Recent): string {
  if (d.commit) return d.commit.sha.slice(0, 7);
  const ref = d.image && !isPanelImage(d.image.reference) ? d.image.reference : "";
  const tag = ref.includes("@") ? "" : ref.slice(ref.lastIndexOf(":") + 1);
  return tag && !tag.includes("/") ? tag : `#${d.generation}`;
}

function deployLine(d: Recent): { tone: Tone; text: string } {
  const node = d.shippedTo.map((n) => n.name).join(", ") || d.builtOn?.name || "-";
  switch (d.status) {
    case "queued":
    case "building":
      if (d.buildWait) return { tone: "run", text: t("dashboard.deploy.waitingForBuild", { node: d.buildWait.node.name }) };
      return { tone: "run", text: t("dashboard.deploy.building", { node }) };
    case "deploying":
      return { tone: "run", text: t("dashboard.deploy.deploying", { node }) };
    case "failed":
      return { tone: "bad", text: d.error ?? t("dashboard.deploy.failed") };
    case "cancelled":
      return { tone: "info", text: t("dashboard.deploy.cancelled") };
    case "superseded":
      return { tone: "ok", text: t("dashboard.deploy.superseded", { label: versionLabel(d), node }) };
    default:
      return { tone: "ok", text: t("dashboard.deploy.live", { label: versionLabel(d), node }) };
  }
}

const severityTone: Record<string, Tone> = { error: "bad", warning: "run", info: "info", ok: "ok" };

export function AlertsCard() {
  const list = useOp(alerts.list, { limit: maxRows });
  return (
    <FeedCard title={t("dashboard.alerts")} link={<Link to="/settings/notifications">{t("dashboard.alertSettings")}</Link>}>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} className="mt-1 mb-2.5" />
      ) : list.isPending ? (
        <FeedSkeleton />
      ) : list.data.alerts.length === 0 ? (
        <Empty>{t("dashboard.noAlerts")}</Empty>
      ) : (
        list.data.alerts.map((alert) => (
          <FeedRow
            key={alert.id}
            tone={severityTone[alert.severity] ?? "info"}
            title={alert.title}
            text={alert.message}
            // Relative like the deploys next to it; the exact time on hover.
            when={formatAgo(alert.createdAt)}
            exact={formatDateTime(alert.createdAt)}
          />
        ))
      )}
    </FeedCard>
  );
}

function FeedCard({ title, link, children }: { title: string; link: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col rounded-card bg-card px-5 pt-[18px] pb-2.5 shadow-card">
      <div className="flex items-center justify-between pb-2">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <span className="text-[13px] font-medium">{link}</span>
      </div>
      {children}
    </section>
  );
}

function FeedRow({ tone, title, text, when, exact }: { tone: Tone; title: ReactNode; text: string; when: string; exact?: string }) {
  const classes = toneClasses[tone];
  return (
    <div className="flex items-center gap-3 border-t border-divider py-2.5">
      <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full ${classes.ring}`}>
        <span className={`size-2 rounded-full ${classes.dot}`} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[13.5px] font-semibold">{title}</b>
        <span className="truncate text-[12.5px] text-muted-foreground">{text}</span>
      </span>
      {exact ? (
        <Tip content={exact}>
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">{when}</span>
        </Tip>
      ) : (
        <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">{when}</span>
      )}
    </div>
  );
}

/** Three feed rows while the list loads (FeedRow's sizes). */
function FeedSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 border-t border-divider py-2.5">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SkeletonText className="w-28 text-[13.5px]" />
            <SkeletonText className="w-56 text-[12.5px]" />
          </span>
          <SkeletonText className="ml-auto w-12 text-xs" />
        </div>
      ))}
    </LoadingRegion>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 border-t border-divider py-4 text-[13px] text-muted-foreground">{children}</p>;
}
