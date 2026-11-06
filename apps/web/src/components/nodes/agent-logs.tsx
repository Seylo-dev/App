// The node agent's own log (its systemd journal) in a modal, read with
// nodes.agentLogs and refreshed every few seconds while the modal is open.

import { nodes } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { LogViewer, useLogBuffer } from "@seylo/ui/components/log-viewer";
import { LoadingRegion, Skeleton } from "@seylo/ui/components/skeleton";
import { useEffect } from "react";
import { t } from "../../i18n/t";
import type { NodeDetail } from "../../lib/types";
import { QueryError } from "../query-error";

const tail = 2000;

export function AgentLogsDialog({ node, open, onOpenChange }: { node: NodeDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[10%] max-w-[860px]">
        <div className="flex flex-col gap-1">
          <DialogTitle>{t("nodes.agentLogsTitle", { name: node.name })}</DialogTitle>
          <DialogDescription>{t("nodes.agentLogsHint")}</DialogDescription>
        </div>
        {open && <AgentLogsBody nodeId={node.id} />}
      </DialogContent>
    </Dialog>
  );
}

function AgentLogsBody({ nodeId }: { nodeId: string }) {
  const buffer = useLogBuffer(tail);
  const logs = useOp(nodes.agentLogs, { nodeId, tail }, { retry: false, refetchInterval: 5000 });
  const entries = logs.data?.entries;

  useEffect(() => {
    if (!entries) return;
    buffer.clear();
    buffer.pushMany(
      entries.map((e) => ({ text: e.line, ts: Date.parse(e.time), level: e.level === "debug" ? "info" : e.level, source: e.level })),
    );
  }, [buffer, entries]);

  if (logs.error && !entries) return <QueryError error={logs.error} onRetry={() => void logs.refetch()} className="mt-4" />;
  return (
    <div className="mt-4">
      <LogViewer
        buffer={buffer}
        aria-label={t("nodes.agentLogs")}
        title={t("nodes.agentLogs")}
        showTimestamps
        showSource
        height={420}
        empty={
          logs.isLoading ? (
            <LoadingRegion label={t("nodes.agentLogsLoading")} className="flex flex-col gap-[9px]">
              {["w-72", "w-96", "w-64", "w-80", "w-56"].map((width) => (
                <Skeleton key={width} className={`h-3 max-w-full rounded-chip bg-terminal-field ${width}`} />
              ))}
            </LoadingRegion>
          ) : (
            <span className="text-terminal-muted">{t("nodes.agentLogsEmpty")}</span>
          )
        }
      />
    </div>
  );
}
