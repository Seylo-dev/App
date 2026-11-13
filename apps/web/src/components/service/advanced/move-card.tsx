// The Advanced tab's "Move to another node" card, for apps, cron services
// and databases on one node (the menus' Move to another node opens it,
// #move). The node picker comes from services.moveImpact: a node the
// panel would refuse is listed with why, and a move that cannot start now
// (a running deploy or backup) says so. The dialog says in plain words
// what happens (move-notes.ts): downtime, the internal and exposed
// addresses and who uses them, backups (with Back up now for a database),
// and the old copy. An app goes to the Deployments tab to follow the move;
// a database (no Deployments tab) shows it here with its log.

import { backups, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { toast } from "@seylo/ui/components/toast";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../../i18n/t";
import { useActiveDeploy } from "../active-deploy";
import { useBackUpNow } from "../backups/back-up-now";
import { DeployLogModal } from "../deploy-log-modal";
import { Field } from "../field";
import { moveCardId } from "../move-card-id";
import { MutationError, retryOp } from "../op-state";
import { isDatabaseKind } from "../status";
import { DeploymentStatusChip } from "../status-chip";
import type { ServiceDetail } from "../use-service";
import { type MoveNote, moveNotes, pickable, targetHint } from "./move-notes";

export function MoveCard({ service }: { service: ServiceDetail }) {
  const database = isDatabaseKind(service.kind);
  const impact = useOp(services.moveImpact, { serviceId: service.id }, { retry: retryOp });
  const navigate = useNavigate();
  const [to, setTo] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [log, setLog] = useState(false);
  const active = useActiveDeploy(service.id);
  const activeId = active?.id ?? null;
  const refetch = impact.refetch;
  // A deploy or a move that starts or ends changes what may be picked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the trigger, not an input
  useEffect(() => {
    void refetch();
  }, [activeId, refetch]);
  const targets = impact.data?.targets ?? [];
  const target = targets.find((n) => n.id === to && pickable(n));
  const move = useOpMutation(services.move, {
    onSuccess: () => {
      if (database) {
        toast.success(t("serviceAdvanced.move.started", { name: service.name, node: target?.name ?? "" }));
        return;
      }
      toast.success(t("serviceEnv.moveStarted"));
      void navigate({ to: "/p/$projectId/s/$serviceId/deployments", params: { projectId: service.projectId, serviceId: service.id } });
    },
  });
  const blocker = impact.data?.blocker ?? null;
  const notes = target && impact.data ? moveNotes(service, impact.data, target) : null;
  const refused = targets.filter((n) => n.refusal);
  const moving = active?.trigger === "move" ? active : null;
  if (service.placements.length !== 1) return null;
  return (
    <SectionCard
      id={moveCardId}
      title={t("serviceAdvanced.move.title")}
      description={database ? t("serviceAdvanced.move.databaseDescription") : t("serviceAdvanced.move.description")}
    >
      {moving ? (
        <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
          <DeploymentStatusChip status={moving.status} />
          <span>{t("serviceAdvanced.move.inProgress", { name: service.name })}</span>
          <Button size="sm" className="ml-auto bg-muted shadow-none" onClick={() => setLog(true)}>
            {t("databaseVersion.viewLog")}
          </Button>
        </div>
      ) : (
        blocker && <Callout tone="neutral">{blocker.message}</Callout>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("serviceAdvanced.move.to")} className="w-72">
          <Select value={to ?? undefined} onValueChange={setTo} disabled={targets.length === 0}>
            <SelectTrigger aria-label={t("serviceAdvanced.move.to")}>
              <SelectValue placeholder={targets.length ? t("serviceAdvanced.move.pick") : t("serviceAdvanced.move.noOther")} />
            </SelectTrigger>
            <SelectContent>
              {targets.map((n) => {
                const hint = targetHint(n);
                return (
                  <SelectItem key={n.id} value={n.id} disabled={!pickable(n)}>
                    {hint ? `${n.name} · ${hint}` : n.name}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        <Button
          onClick={() => {
            void refetch();
            setConfirm(true);
          }}
          // A deploy in progress holds it at once, before the impact's next read says so.
          disabled={!target || move.isPending || blocker !== null || active !== null}
          title={active && !moving ? t("serviceAdvanced.placement.deployBusy") : undefined}
        >
          {t("serviceAdvanced.move.button")}
        </Button>
        <MutationError error={move.error ?? impact.error} />
      </div>
      {refused.length > 0 && (
        <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
          <span>{t("serviceAdvanced.move.cannotGo")}</span>
          <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
            {refused.map((n) => (
              <li key={n.id}>{n.refusal?.message}</li>
            ))}
          </ul>
        </div>
      )}
      {/* Before the move: everything it does, in plain words, for the node picked. */}
      {notes && target && (
        <div className="flex flex-col gap-2 border-t border-divider pt-4">
          <span className="text-[13px] font-medium text-ink-strong">{t("serviceAdvanced.move.whatHappens", { node: target.name })}</span>
          <MoveNotes service={service} label={t("serviceAdvanced.move.whatHappens", { node: target.name })} notes={notes} />
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("serviceAdvanced.move.confirmTitle", { name: service.name, node: target?.name ?? "" })}
        description={database ? t("serviceAdvanced.move.confirmFollowDatabase") : t("serviceAdvanced.move.confirmFollow")}
        confirmLabel={t("serviceAdvanced.move.button")}
        onConfirm={() => (target ? move.mutateAsync({ serviceId: service.id, toNodeId: target.id }).then(() => undefined) : undefined)}
      >
        {/* The downtime and what needs you, again; the card has the rest. Long lists scroll inside on a short screen. */}
        {notes && target && (
          <div className="max-h-[50vh] overflow-y-auto">
            <MoveNotes
              service={service}
              label={t("serviceAdvanced.move.confirmTitle", { name: service.name, node: target.name })}
              notes={notes.filter((n) => confirmNotes.has(n.id))}
            />
          </div>
        )}
      </ConfirmDialog>
      <DeployLogModal serviceId={service.id} deployment={log ? moving : null} onClose={() => setLog(false)} />
    </SectionCard>
  );
}

/** What the confirm dialog repeats: the downtime, and what asks something of you. */
const confirmNotes: ReadonlySet<MoveNote["id"]> = new Set(["downtime", "size", "leftBehind", "tlsHostname", "exposedReferrers", "backup"]);

function MoveNotes({ service, label, notes }: { service: ServiceDetail; label: string; notes: MoveNote[] }) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-2 p-0">
      {notes.map((note) => (
        <li key={note.id} data-note={note.id} className="flex flex-col gap-1 text-[13px] leading-relaxed">
          <span className={note.tone === "warning" ? "text-chip-amber-fg" : "text-ink-strong"}>{note.text}</span>
          {note.items && (
            <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 font-mono text-[12.5px] text-muted-foreground">
              {note.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {note.id === "backup" && <BackUpFirst service={service} />}
        </li>
      ))}
    </ul>
  );
}

/** Back up now, as on the Backups tab: every schedule, or a database's one-off dump; a link to set them up without. */
function BackUpFirst({ service }: { service: ServiceDetail }) {
  const policies = useOp(backups.listPolicies, { serviceId: service.id }, { retry: retryOp });
  const destinations = useOp(backups.listDestinations, {}, { retry: retryOp });
  const backUpNow = useBackUpNow(service, policies.data?.policies, destinations.data?.choices ?? []);
  if (!policies.data) return null;
  const none = policies.data.policies.length === 0 && (!isDatabaseKind(service.kind) || (destinations.data?.choices.length ?? 0) === 0);
  if (none) {
    return (
      <Link
        to="/p/$projectId/s/$serviceId/backups"
        params={{ projectId: service.projectId, serviceId: service.id }}
        className="self-start text-[13px] font-medium text-link"
      >
        {t("serviceAdvanced.move.notes.setUpBackups")}
      </Link>
    );
  }
  return (
    <Button size="sm" className="self-start bg-muted shadow-none" disabled={backUpNow.disabled} onClick={backUpNow.run}>
      {t("serviceAdvanced.move.notes.backUpNow")}
    </Button>
  );
}
