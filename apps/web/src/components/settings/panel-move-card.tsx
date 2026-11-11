// Settings > General > Move the panel to another server (0.2.8), for the
// owner only. One card follows the move from start to end:
//
//   form      what a move does, the node to move to (nodes that cannot take
//             it are listed but disabled, with their reason), the address
//             other servers reach it at (prefilled), what refuses it right
//             now, and the tick for nodes that cannot follow. Start asks
//             first; a stale sign-in opens the re-auth dialog (lib/reauth.ts).
//   moving    the steps with the current one, bytes copied, Cancel until
//             the switch. When the target does not confirm the switch: how
//             long the panel has waited, and after 10 minutes Cancel anyway.
//   failed    where it stopped and why; nothing changed. Try again.
//   done      on the moved panel: the DNS hint for a domain, the nodes to
//             join again, and Delete the old copy. On the old copy (it still
//             answers for a moment): where the panel is now, at its new IP
//             address first (the domain still points here).
//
// The panel decides and refuses (panelMove.check, panelMove.start); the
// card shows its reasons and never guesses. The live socket refreshes the
// status while the move runs; a 2 second poll covers a dropped socket.
// The check refreshes every 10 seconds while the form shows, on focus and
// after a refused start, and names the typed address in its warnings. When
// the old panel stops answering after the switch, the card says where the
// panel went; before the switch, where it is if the move finished, with
// Retry (lib/panel-move.ts).

import { slug } from "@seylo/brand";
import { auth, OpError, type OpOutput, panelMove } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input } from "@seylo/ui/components/input";
import { Progress } from "@seylo/ui/components/progress";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconCircleCheck, IconCircleDashed, IconExternalLink, IconLoader2 } from "@tabler/icons-react";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { t } from "../../i18n/t";
import { formatBytes, formatDuration, formatNames } from "../../lib/format";
import { followMovePoll, lostMove, movedLinks } from "../../lib/panel-move";
import { isReauthCancelled } from "../../lib/reauth";
import { useNow } from "../service/use-now";
import { invalidateOps, useSettingsMutation } from "./mutation";
import { errorText, QueryView } from "./op-state";
import { Field } from "./page";

export type MoveStatus = OpOutput<typeof panelMove.status>;
export type MoveCheck = OpOutput<typeof panelMove.check>;
type Step = NonNullable<MoveStatus["step"]>;

export const moveSteps: readonly Step[] = ["pausing", "registry", "snapshot", "shipping", "starting", "staging", "switching"];

/** The target reasons the node picker shows next to a node that cannot take the panel. */
const targetCodes = ["targetIsPanel", "targetOffline", "targetDisabled", "targetTooOld", "targetPlainHttp"] as const;
type TargetCode = (typeof targetCodes)[number];

/** How often the form asks panelMove.check again while it shows: work that finished, a node that went offline. */
const checkRefreshMs = 10_000;
/** How long the typed address rests before the check names it in its warnings. */
const addressSettleMs = 400;

const howKeys = ["copies", "nodes", "readOnly", "oldCopy", "domain"] as const;

/** Only the owner moves the panel; everyone else never sees the card. */
export function PanelMoveCard() {
  const me = useOp(auth.whoami, {});
  if (me.data?.viewer.role !== "owner") return null;
  return <OwnerCard />;
}

function OwnerCard() {
  const status = useOp(panelMove.status, {}, { refetchInterval: followMovePoll(2000) });
  // The panel stopped answering during the move: past the switch it went through, most likely.
  const lost = lostMove(status);
  return (
    <SectionCard title={t("settingsPanelMove.title")} description={t("settingsPanelMove.description")}>
      {lost?.moved ? (
        <MovedAway status={lost.status} lost />
      ) : lost ? (
        <MoveLost status={lost.status} retrying={status.isFetching} onRetry={() => void status.refetch()} />
      ) : (
        <QueryView query={status} skeleton={<MoveSkeleton />} className="flex flex-col gap-4">
          {(data) => (
            <div className="flex flex-col gap-4">
              <MoveBody status={data} form={(compact) => <MoveForm compact={compact} />} />
            </div>
          )}
        </QueryView>
      )}
    </SectionCard>
  );
}

/** The card shows a failed move until Try again on that move; the failure of a later move shows again. */
export function showsFailure(status: Pick<MoveStatus, "state" | "moveId">, dismissed: string | null | undefined): boolean {
  return status.state === "failed" && status.moveId !== dismissed;
}

/**
 * Which part of the card shows for a status. `form` renders the form (its
 * own queries), so tests render the other states without it.
 */
export function MoveBody({ status, form }: { status: MoveStatus; form: (compact: boolean) => React.ReactNode }) {
  // The move whose failure Try again put away (undefined: none yet).
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
  if (status.state === "running") return <MoveProgress status={status} />;
  if (status.state === "done" && status.side === "old") return <MovedAway status={status} />;
  return (
    <>
      {status.state === "done" && <MoveResult status={status} />}
      {showsFailure(status, dismissed) ? (
        <MoveFailed status={status} onRetry={() => setDismissed(status.moveId)} />
      ) : (
        form(status.state !== "idle")
      )}
    </>
  );
}

function HowItWorks() {
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
      {howKeys.map((key) => (
        <li key={key}>{t(`settingsPanelMove.how.${key}`)}</li>
      ))}
    </ul>
  );
}

/** The panel refused the typed address (BAD_REQUEST on field address): its words, else null. */
function addressRefusal(error: unknown): string | null {
  return error instanceof OpError && error.code === "BAD_REQUEST" && error.details?.field === "address" ? error.message : null;
}

/**
 * What the form renders for the check. While its latest ask failed (a
 * refused address, a network blip, a busy panel) the form keeps the last
 * answer, so the typed address and the tick stay: `refused` is the panel's
 * words on the address, `stale` any other failure. Without a last answer
 * the failure is the card's load error.
 */
export function formCheck<Q extends { data?: MoveCheck | undefined; error: unknown }>(
  check: Q,
  last: MoveCheck | undefined,
): { shown: Q; refused: string | null; stale: unknown } {
  const refused = addressRefusal(check.error);
  if (!check.error || !last) return { shown: check, refused, stale: null };
  return { shown: { ...check, data: last, error: null }, refused, stale: refused ? null : check.error };
}

function MoveForm({ compact }: { compact: boolean }) {
  const [target, setTarget] = useState<string | null>(null);
  // The typed address the check names in its warnings once it parses; null: the node's default.
  const [address, setAddress] = useState<string | null>(null);
  const check = useOp(panelMove.check, target ? { targetNodeId: target, ...(address ? { address } : {}) } : {}, {
    placeholderData: keepPreviousData,
    // Blocks clear and nodes drop off while the form shows.
    refetchInterval: (query) => (addressRefusal(query.state.error) ? false : checkRefreshMs),
    refetchOnWindowFocus: "always",
  });
  const [last, setLast] = useState<MoveCheck | undefined>(undefined);
  useEffect(() => {
    if (check.data && !check.isPlaceholderData) setLast(check.data);
  }, [check.data, check.isPlaceholderData]);
  // A failed ask keeps the form with the last answer: a refused address shows why under the field.
  const { shown, refused, stale } = formCheck(check, last);
  return (
    <QueryView query={shown} skeleton={<FormSkeleton />}>
      {(data) => (
        <MoveFormView
          // A new target starts the address field and the tick over.
          key={data.targetNodeId ?? ""}
          check={data}
          target={target}
          loading={check.isFetching && data.targetNodeId !== target}
          onTarget={(nodeId) => {
            setTarget(nodeId);
            setAddress(null);
          }}
          onAddress={setAddress}
          refused={refused && address ? { address, message: refused } : null}
          stale={stale ? errorText(stale) : null}
          compact={compact}
        />
      )}
    </QueryView>
  );
}

/** "b1 (offline)" for a node that cannot take the panel. */
export function targetLabel(node: MoveCheck["targets"][number]): string {
  const code = node.blocks.find((block) => (targetCodes as readonly string[]).includes(block.code))?.code as TargetCode | undefined;
  if (code) return `${node.name} (${t(`settingsPanelMove.reasons.${code}`)})`;
  // A reason this page does not know yet (a newer panel): still say it cannot.
  return node.ready ? node.name : `${node.name} (${t("settingsPanelMove.reasons.other")})`;
}

const addressShape = /^(\[[0-9a-f:.]+\]|[0-9a-f:.]+|[a-z0-9.-]+)$/i;

export function MoveFormView({
  check,
  target,
  loading = false,
  onTarget,
  onAddress,
  refused = null,
  stale = null,
  compact = false,
}: {
  check: MoveCheck;
  target: string | null;
  /** The check for a newly picked target is on its way. */
  loading?: boolean;
  onTarget: (nodeId: string) => void;
  /** The typed address once it parses and rested a moment (null: the default), for the check's warnings. */
  onAddress?: (address: string | null) => void;
  /** The panel refused this address, in these words. */
  refused?: { address: string; message: string } | null;
  /** Asking the panel again failed, in these words: `check` is its last answer. */
  stale?: string | null;
  /** Without the explanation: a result or a failure above says enough. */
  compact?: boolean;
}) {
  const ready = check.targetNodeId !== null && check.targetNodeId === target && !loading;
  // What the person typed; untouched, the field follows the node's default address.
  const [typed, setTyped] = useState<string | null>(null);
  // The nodes the tick was given for: a node that drops off since needs a new tick.
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const tickId = useId();
  const addressId = useId();
  const start = useSettingsMutation(panelMove.start, {
    invalidates: [panelMove.status, panelMove.check],
    failure: false,
    // A refusal names what changed (work started, a node went offline): show the panel's view of it.
    onError: () => void invalidateOps([panelMove.check, panelMove.status]),
  });
  const hard = check.blocks.filter((block) => !block.soft);
  const targetNode = check.targets.find((node) => node.id === check.targetNodeId);
  const address = typed ?? check.defaultAddress ?? "";
  const trimmed = address.trim();
  const malformed = trimmed !== "" && (trimmed.length > 253 || !addressShape.test(trimmed));
  const refusedHere = refused?.address === trimmed ? refused.message : null;
  const addressError = malformed ? t("settingsPanelMove.addressInvalid") : refusedHere;
  const leftKey = check.nodesLeftBehind.map((node) => node.id).join(",");
  const leftBehind = tickedFor === leftKey;
  const needsTick = ready && check.nodesLeftBehind.length > 0;
  const canStart = ready && hard.length === 0 && trimmed !== "" && !addressError && (!needsTick || leftBehind) && !start.isPending;

  // The warnings name the typed address, once it parses and the typing paused.
  const settled = ready && trimmed !== "" && !malformed ? trimmed : null;
  useEffect(() => {
    if (!onAddress || settled === null) return;
    const timer = setTimeout(() => onAddress(settled === check.defaultAddress ? null : settled), addressSettleMs);
    return () => clearTimeout(timer);
  }, [settled, check.defaultAddress, onAddress]);

  return (
    <div className="flex flex-col gap-4">
      {!compact && <HowItWorks />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("settingsPanelMove.target")} hint={t("settingsPanelMove.targetHint")} htmlFor="panel-move-target">
          <Select value={target ?? ""} onValueChange={onTarget}>
            <SelectTrigger id="panel-move-target" loading={loading} aria-label={t("settingsPanelMove.target")}>
              <SelectValue placeholder={t("settingsPanelMove.targetPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {check.targets.map((node) => (
                <SelectItem key={node.id} value={node.id} disabled={!node.ready}>
                  {targetLabel(node)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {ready && (
          <Field
            label={t("settingsPanelMove.address")}
            hint={t("settingsPanelMove.addressHint", hint(check, targetNode?.name, trimmed))}
            error={addressError}
            htmlFor={addressId}
          >
            <Input
              id={addressId}
              value={address}
              placeholder={t("settingsPanelMove.addressPlaceholder")}
              className="font-mono text-[12.5px]"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        )}
      </div>

      {hard.length > 0 && (
        <Alert tone="neutral" title={t("settingsPanelMove.blockedTitle")}>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
            {hard.map((block) => (
              <li key={`${block.code}:${block.message}`}>{block.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      {ready && check.nodesLeftBehind.length > 0 && (
        <div className="flex flex-col gap-2 rounded-control bg-raised px-3 py-2.5">
          <span className="text-[13px] font-medium text-ink-strong">{t("settingsPanelMove.leftBehindTitle")}</span>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4 text-[13px] text-muted-foreground">
            {check.nodesLeftBehind.map((node) => (
              <li key={node.id}>
                {node.name}: {t(`settingsPanelMove.leftBehindReasons.${node.reason}`)}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <Checkbox id={tickId} checked={leftBehind} onCheckedChange={(value) => setTickedFor(value === true ? leftKey : null)} />
            <label htmlFor={tickId} className="cursor-pointer text-[13px] text-ink-strong">
              {t("settingsPanelMove.leftBehindTick", { command: `${slug} join --force` })}
            </label>
          </div>
        </div>
      )}

      {ready && check.nodesToMove.length > 0 && (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("settingsPanelMove.following", {
            count: check.nodesToMove.length,
            nodes: formatNames(check.nodesToMove.map((node) => node.name)),
          })}
        </p>
      )}
      {ready &&
        check.warnings.map((warning) => (
          <p key={warning.code} className="m-0 text-[12.5px] text-muted-foreground">
            {warning.message}
          </p>
        ))}

      {stale && (
        <p role="status" className="m-0 text-[12.5px] text-chip-amber-fg">
          {t("settingsPanelMove.checkStale", { reason: stale })}
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="primary" disabled={!canStart} onClick={() => setConfirming(true)}>
          {t("settingsPanelMove.start")}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("settingsPanelMove.confirmTitle", { node: targetNode?.name ?? "" })}
        description={t("settingsPanelMove.confirmDescription", {
          node: targetNode?.name ?? "",
          address: trimmed,
          from: check.fromNode?.name ?? "",
        })}
        confirmLabel={t("settingsPanelMove.confirmButton")}
        onConfirm={async () => {
          if (!check.targetNodeId) return;
          try {
            await start.mutateAsync({
              targetNodeId: check.targetNodeId,
              address: trimmed,
              ...(check.nodesLeftBehind.length > 0 ? { leftBehind } : {}),
            });
          } catch (error) {
            // The person closed the re-auth dialog: nothing failed, this one closes too.
            if (isReauthCancelled(error)) return;
            throw error;
          }
        }}
      />
    </div>
  );
}

function hint(check: MoveCheck, node: string | undefined, host: string) {
  const shown = host || check.defaultAddress || t("settingsPanelMove.addressPlaceholder");
  return {
    node: node ?? "",
    host: shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown,
    port: check.agentPort ?? 3443,
  };
}

function stepText(step: Step, node: string): string {
  return t(`settingsPanelMove.steps.${step}`, { node });
}

/** How far the move got, 0 to 100: the steps done, plus the bytes of the one running. */
export function moveProgress(status: MoveStatus): number {
  const index = status.step ? moveSteps.indexOf(status.step) : 0;
  const part = status.bytesTotal > 0 ? Math.min(1, status.bytesDone / status.bytesTotal) : 0;
  return Math.round(((Math.max(0, index) + part) / moveSteps.length) * 100);
}

export function MoveProgress({ status }: { status: MoveStatus }) {
  const node = status.targetNodeName ?? "";
  const current = status.step ? moveSteps.indexOf(status.step) : 0;
  const [forcing, setForcing] = useState(false);
  const cancel = useSettingsMutation(panelMove.cancel, {
    invalidates: [panelMove.status],
    success: t("settingsPanelMove.cancelled"),
  });
  // The dialog shows a refusal itself (the target confirmed meanwhile, say).
  const forceCancel = useSettingsMutation(panelMove.cancel, {
    invalidates: [panelMove.status, panelMove.check],
    success: t("settingsPanelMove.cancelled"),
    failure: false,
  });
  const bytes =
    status.bytesTotal > 0
      ? t("settingsPanelMove.bytes", { done: formatBytes(status.bytesDone), total: formatBytes(status.bytesTotal) })
      : status.bytesDone > 0
        ? t("settingsPanelMove.bytesDone", { done: formatBytes(status.bytesDone) })
        : null;
  return (
    <div data-testid="panel-move-progress" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-ink-strong">{t("settingsPanelMove.movingTitle", { node })}</span>
        <span className="text-[12.5px] text-muted-foreground">{t("settingsPanelMove.movingHint")}</span>
      </div>
      <Progress value={moveProgress(status)} aria-label={t("settingsPanelMove.movingTitle", { node })} />
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {moveSteps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "pending";
          const Icon = state === "done" ? IconCircleCheck : state === "current" ? IconLoader2 : IconCircleDashed;
          return (
            <li
              key={step}
              aria-current={state === "current" ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 text-[13px] transition-colors duration-200",
                state === "pending" ? "text-ink-faint" : "text-ink-strong",
              )}
            >
              <Icon
                size={16}
                stroke={1.9}
                aria-hidden="true"
                className={cn(state === "done" && "text-status-ok", state === "current" && "animate-spin text-primary")}
              />
              <span>{stepText(step, node)}</span>
              {state === "current" && bytes && <span className="text-muted-foreground">{bytes}</span>}
            </li>
          );
        })}
      </ol>
      {status.waitingSince && <MoveWaiting status={status} since={status.waitingSince} onForceCancel={() => setForcing(true)} />}
      {status.canCancel && (
        <div className="flex justify-end">
          <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate({})}>
            {t("settingsPanelMove.cancel")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={forcing}
        onOpenChange={setForcing}
        destructive
        title={t("settingsPanelMove.forceCancelTitle")}
        description={t("settingsPanelMove.forceCancelDescription", { node })}
        confirmLabel={t("settingsPanelMove.forceCancel")}
        cancelLabel={t("settingsPanelMove.forceCancelKeep")}
        onConfirm={async () => {
          try {
            await forceCancel.mutateAsync({ force: true });
          } catch (error) {
            if (isReauthCancelled(error)) return;
            throw error;
          }
        }}
      />
    </div>
  );
}

/**
 * The switch waits for the target to confirm it: the panel stays read-only
 * and keeps its nodes, and asks again every few seconds. After 10 minutes
 * (canForceCancel) the owner may cancel anyway, for a target that is gone.
 */
function MoveWaiting({ status, since, onForceCancel }: { status: MoveStatus; since: string; onForceCancel: () => void }) {
  const now = useNow(1000);
  const node = status.targetNodeName ?? "";
  return (
    <Alert
      tone="warning"
      title={t("settingsPanelMove.waitingTitle", { node })}
      action={
        status.canForceCancel ? (
          <Button variant="secondary" size="sm" onClick={onForceCancel}>
            {t("settingsPanelMove.forceCancel")}
          </Button>
        ) : undefined
      }
    >
      <p className="m-0">{t("settingsPanelMove.waitingHint", { node, duration: formatDuration(Math.max(0, now - Date.parse(since))) })}</p>
      {status.canForceCancel && <p className="m-0">{t("settingsPanelMove.forceCancelHint", { node })}</p>}
    </Alert>
  );
}

export function MoveFailed({ status, onRetry }: { status: MoveStatus; onRetry: () => void }) {
  return (
    <Alert
      tone="danger"
      title={t("settingsPanelMove.failedTitle", { node: status.targetNodeName ?? "" })}
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("settingsPanelMove.tryAgain")}
        </Button>
      }
    >
      <p className="m-0">{status.error?.message}</p>
      {status.error && (
        <p className="m-0">{t("settingsPanelMove.failedStep", { step: stepText(status.error.step, status.targetNodeName ?? "") })}</p>
      )}
      <p className="m-0">{t("settingsPanelMove.failedHint")}</p>
    </Alert>
  );
}

export function MoveResult({ status }: { status: MoveStatus }) {
  const [deleting, setDeleting] = useState(false);
  const from = status.fromNodeName ?? "";
  const remove = useSettingsMutation(panelMove.removeOldCopy, {
    invalidates: [panelMove.status],
    success: (output) => t("settingsPanelMove.deleted", { node: from, size: formatBytes(output.freedBytes) }),
    failure: false,
  });
  return (
    <div data-testid="panel-move-result" className="flex flex-col gap-3">
      <Alert tone="success" title={t("settingsPanelMove.doneTitle", { node: status.targetNodeName ?? "" })}>
        <p className="m-0">
          {t("settingsPanelMove.doneHint", { url: status.newUrl ?? "", command: `${slug} login ${status.newUrl ?? ""}` })}
        </p>
        {status.domain && (
          <p className="m-0">{t("settingsPanelMove.domainHint", { domain: status.domain, address: status.targetAddress ?? "" })}</p>
        )}
        {status.leftBehind.length > 0 && (
          <p className="m-0">{t("settingsPanelMove.leftBehindDone", { nodes: formatNames(status.leftBehind.map((node) => node.name)) })}</p>
        )}
      </Alert>
      {status.oldCopyRemoved ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">{t("settingsPanelMove.oldCopyGone", { node: from })}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-raised px-3 py-2.5">
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1 text-[13px]">
            <span className="text-ink-strong">{t("settingsPanelMove.oldCopy", { node: from })}</span>
            {status.oldPanelRunning && <span className="text-chip-amber-fg">{t("settingsPanelMove.oldPanelRunning", { node: from })}</span>}
          </div>
          <Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>
            {t("settingsPanelMove.deleteOldCopy")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={t("settingsPanelMove.deleteTitle", { node: from })}
        description={t("settingsPanelMove.deleteDescription", { node: from })}
        confirmLabel={t("settingsPanelMove.deleteButton")}
        confirmText={from}
        onConfirm={async () => {
          try {
            await remove.mutateAsync({});
          } catch (error) {
            if (isReauthCancelled(error)) return;
            throw error;
          }
        }}
      />
    </div>
  );
}

/**
 * The old copy, which still answers for a moment after the switch: where
 * the panel is now. `lost`: this page only saw the old panel stop answering
 * at the end of the move.
 */
export function MovedAway({ status, lost = false }: { status: MoveStatus; lost?: boolean }) {
  const { url, domainUrl } = movedLinks(status);
  return (
    <Alert
      tone="info"
      title={t("settingsPanelMove.movedAwayTitle", { node: status.targetNodeName ?? "" })}
      action={
        url ? (
          <Button variant="secondary" size="sm" asChild>
            <a href={url}>
              {t("settingsPanelMove.open", { url })}
              <IconExternalLink size={14} aria-hidden="true" />
            </a>
          </Button>
        ) : undefined
      }
    >
      <p className="m-0">{lost ? t("settingsPanelMove.movedLostHint") : t("settingsPanelMove.movedAwayHint")}</p>
      {domainUrl && (
        <p className="m-0">
          <a href={domainUrl} className="font-medium text-link hover:text-link-hover">
            {status.domain}
          </a>{" "}
          {t("settingsPanelMove.movedAwayDomain", { address: status.targetAddress ?? t("settingsPanelMove.newServer") })}
        </p>
      )}
    </Alert>
  );
}

/**
 * This server stopped answering before the switch went ahead (a restart, a
 * lost route, or a move that finished while this page did not look): the
 * new address in case the move finished, and Retry. A move that fails
 * instead shows once this server answers again.
 */
export function MoveLost({ status, onRetry, retrying = false }: { status: MoveStatus; onRetry: () => void; retrying?: boolean }) {
  const { url } = movedLinks(status);
  const node = status.targetNodeName ?? "";
  return (
    <Alert
      tone="warning"
      title={t("settingsPanelMove.lostTitle", { node })}
      action={
        <>
          <Button variant="secondary" size="sm" disabled={retrying} onClick={onRetry}>
            {t("common.retry")}
          </Button>
          {url && (
            <Button variant="secondary" size="sm" asChild>
              <a href={url}>
                {t("settingsPanelMove.open", { url })}
                <IconExternalLink size={14} aria-hidden="true" />
              </a>
            </Button>
          )}
        </>
      }
    >
      <p className="m-0">{t("settingsPanelMove.lostHint", { node })}</p>
    </Alert>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <SkeletonText className="w-72 text-[13px]" />
        <SkeletonText className="w-80 text-[13px]" />
        <SkeletonText className="w-64 text-[13px]" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SkeletonText className="w-16 text-[12.5px]" />
          <Skeleton className="h-[38px]" />
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}

function MoveSkeleton() {
  return <FormSkeleton />;
}
