// The Shell view of the node sheet: a root login shell on the node itself,
// through the same terminal as a service's Console tab. Off until the owner
// allows it for the node (a recent sign-in, asked for by the re-auth
// dialog); then owners and admins open one, each after a recent sign-in,
// at most two at a time, closed after 15 minutes without input or output.
//
// ?prefill=<name> (added in 0.2.1, Settings > Tailscale's Install button)
// opens the shell and types one command from a fixed list once the shell is
// ready, never with Enter: the person reads it and runs it. Unknown names
// are dropped by the route's validateSearch.

import { hostShell, type OpOutput } from "@seylo/ops";
import { useOp, useOpClient, useOpMutation } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { CopyCode } from "@seylo/ui/components/code-block";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconLock, IconTerminal2, IconX } from "@tabler/icons-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatAgo } from "../../lib/format";
import { isReauthCancelled } from "../../lib/reauth";
import type { NodeDetail } from "../../lib/types";
import { QueryError } from "../query-error";
import { TerminalPanel } from "../service/terminal/terminal-panel";
import { isShellPrefill, shellPrefills } from "./shell-prefill";

export { isShellPrefill, type ShellPrefill, shellPrefills } from "./shell-prefill";

/** What the prefill note says before the command is typed: why no shell types it here, by cause. */
export function prefillText(s: Pick<OpOutput<typeof hostShell.status>, "enabled" | "available" | "canOpen" | "canEnable">) {
  if (!s.enabled) return s.canEnable ? ("nodeShell.prefillOff" as const) : ("nodeShell.prefillOffOwner" as const);
  if (!s.available) return "nodeShell.prefillUnavailable" as const;
  if (!s.canOpen) return "nodeShell.prefillCannotOpen" as const;
  return "nodeShell.prefillHint" as const;
}

/** The prefill of the nodes route, and a way to drop it from the URL once it is typed. */
function usePrefill(): { command: string | null; done: () => void } {
  const search = useSearch({ strict: false }) as { prefill?: unknown };
  const navigate = useNavigate();
  const name = isShellPrefill(search.prefill) ? search.prefill : null;
  const done = useCallback(() => {
    void navigate({ to: "/nodes", search: (prev) => ({ ...prev, prefill: undefined }), replace: true });
  }, [navigate]);
  return { command: name ? shellPrefills[name] : null, done };
}

export function NodeShell({ node }: { node: NodeDetail }) {
  const status = useOp(hostShell.status, { nodeId: node.id });
  const prefill = usePrefill();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const setEnabled = useOpMutation(hostShell.setEnabled, {
    onSuccess: (out) => {
      toast.success(out.enabled ? t("nodeShell.enabled", { name: node.name }) : t("nodeShell.disabled", { name: node.name }));
      if (!out.enabled) setOpen(false);
      void status.refetch();
    },
  });

  // The command from the URL, typed into the first shell opened here and only that one.
  const [command, setCommand] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (prefill.command) setCommand(prefill.command);
  }, [prefill.command]);
  const { done } = prefill;
  const onPrefilled = useCallback(() => {
    setTyped(true);
    done();
  }, [done]);
  // A command to type opens the shell by itself once it can be opened.
  const canOpenNow = status.data?.enabled === true && status.data.available && status.data.canOpen;
  useEffect(() => {
    if (command && !typed && canOpenNow) setOpen(true);
  }, [command, typed, canOpenNow]);

  if (status.isError) return <QueryError error={status.error} onRetry={() => void status.refetch()} />;
  if (status.isPending) return <ShellSkeleton />;
  const s = status.data;
  const minutes = Math.round(s.idleTimeoutSeconds / 60);
  const prefillNote = command && (
    <Alert tone="info" title={t("nodeShell.prefillTitle")}>
      <span className="flex flex-col items-start gap-1.5">
        {t(typed ? "nodeShell.prefillTyped" : prefillText(s))}
        <CopyCode code={command} aria-label={t("nodeShell.prefillCommand")} />
      </span>
    </Alert>
  );

  if (!s.enabled) {
    return (
      <section aria-label={t("nodeShell.offTitle")} className="flex flex-col items-start gap-3 rounded-control bg-raised p-4">
        <div className="flex items-center gap-2">
          <IconLock size={17} stroke={1.9} aria-hidden="true" className="text-muted-foreground" />
          <h3 className="m-0 text-sm font-semibold">{t("nodeShell.offTitle")}</h3>
        </div>
        <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">{t("nodeShell.offHint", { minutes })}</p>
        {prefillNote}
        {s.canEnable ? (
          <Button size="sm" variant="primary" disabled={setEnabled.isPending} onClick={() => setConfirm(true)}>
            {t("nodeShell.enable")}
          </Button>
        ) : (
          <span className="text-[12.5px] text-ink-strong">{t("nodeShell.ownerOnly")}</span>
        )}
        {setEnabled.error && !isReauthCancelled(setEnabled.error) && (
          <Alert tone="danger">{errorMessage(setEnabled.error, t("common.unknownError"))}</Alert>
        )}
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          destructive
          title={t("nodeShell.confirmTitle", { name: node.name })}
          description={t("nodeShell.confirmHint")}
          confirmLabel={t("nodeShell.enable")}
          onConfirm={async () => {
            try {
              await setEnabled.mutateAsync({ nodeId: node.id, enabled: true });
            } catch (error) {
              // Closing the "Confirm it's you" dialog is not an error to show.
              if (!isReauthCancelled(error)) throw error;
            }
          }}
        />
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section aria-label={t("nodeShell.title", { name: node.name })} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="green">{t("nodeShell.allowed")}</Chip>
          {s.sessions.length > 0 && <Chip tone="amber">{t("nodeShell.openNow", { count: s.sessions.length })}</Chip>}
          {(s.canEnable || s.canOpen) && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ nodeId: node.id, enabled: false })}
            >
              {t("nodeShell.disable")}
            </Button>
          )}
        </div>
        {/* Who has the open shells, right under the "open now" chip they explain; the limits after. */}
        {s.sessions.length > 0 && (
          <ul aria-label={t("nodeShell.openList")} className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px] text-ink-strong">
            {s.sessions.map((session) => (
              <li key={session.id}>{t("nodeShell.openedBy", { name: session.openedBy, when: formatAgo(session.openedAt) })}</li>
            ))}
          </ul>
        )}
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("nodeShell.limits", { max: s.maxSessions, minutes })}</p>
        {setEnabled.error && !isReauthCancelled(setEnabled.error) && (
          <Alert tone="danger">{errorMessage(setEnabled.error, t("common.unknownError"))}</Alert>
        )}
      </section>
      {prefillNote}
      {!s.available ? (
        <Alert tone="neutral">{t("nodeShell.unavailable")}</Alert>
      ) : open ? (
        <HostTerminal
          node={node}
          minutes={minutes}
          onClose={() => setOpen(false)}
          prefill={typed ? undefined : (command ?? undefined)}
          onPrefilled={onPrefilled}
        />
      ) : (
        s.canOpen && (
          <Button variant="primary" className="self-start" onClick={() => setOpen(true)}>
            <IconTerminal2 size={15} aria-hidden="true" />
            {t("nodeShell.open")}
          </Button>
        )
      )}
    </div>
  );
}

function HostTerminal({
  node,
  minutes,
  onClose,
  prefill,
  onPrefilled,
}: {
  node: NodeDetail;
  minutes: number;
  onClose: () => void;
  prefill?: string;
  onPrefilled?: () => void;
}) {
  const client = useOpClient();
  const source = useMemo(
    () => ({ open: (size: { columns: number; rows: number }) => client.call(hostShell.open, { nodeId: node.id, ...size }) }),
    [client, node.id],
  );
  return (
    <TerminalPanel
      key={node.id}
      label={t("nodeShell.title", { name: node.name })}
      switcher={
        <div className="flex items-center gap-1">
          <span className="px-1.5 text-[12.5px] font-medium text-terminal-foreground">{t("nodeShell.title", { name: node.name })}</span>
          <button
            type="button"
            aria-label={t("nodeShell.close")}
            onClick={onClose}
            className="flex cursor-pointer rounded-chip border-0 bg-transparent p-[5px] text-terminal-muted hover:text-terminal-foreground"
          >
            <IconX size={14} stroke={1.9} />
          </button>
        </div>
      }
      subtitle={t("nodeShell.subtitle")}
      source={source}
      describe={(info) => {
        // The agent's user from its first message (root on an installed node).
        const where = info.user
          ? t("nodeShell.connected", { node: node.name, user: info.user, workdir: info.workdir || "/" })
          : t("nodeShell.connectedNoUser", { node: node.name, workdir: info.workdir || "/" });
        return `${where} · ${t("nodeShell.idle", { minutes })}`;
      }}
      keyboard
      fileName={`${node.name}-host-shell.log`}
      minHeight={440}
      prefill={prefill}
      onPrefilled={onPrefilled}
    />
  );
}

/** Shaped like the off state, which every node starts in: the lock heading, the two-line hint and the button. */
export function ShellSkeleton() {
  return (
    <LoadingRegion label={t("nodeShell.loading")} className="flex flex-col items-start gap-3 rounded-control bg-raised p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="size-[17px] shrink-0 rounded-[4px] bg-track" />
        <SkeletonText ground className="w-44 text-sm" />
      </div>
      <span className="flex w-full flex-col">
        <SkeletonText ground className="w-full text-[12.5px] leading-relaxed" />
        <SkeletonText ground className="w-2/3 text-[12.5px] leading-relaxed" />
      </span>
      <ButtonSkeleton size="sm" className="w-28 bg-track" />
    </LoadingRegion>
  );
}
