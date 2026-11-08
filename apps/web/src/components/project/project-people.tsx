// People with access to a project (grants on it or on one of its
// services), and the Share dialog that gives an existing member access
// with one of three presets. Inviting someone new and fine-grained
// actions live in Settings > People.

import { allOps, grantableActions, grants, users } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { DataTable } from "@seylo/ui/components/data-table";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { EmptyState } from "@seylo/ui/components/empty-state";
import { Label } from "@seylo/ui/components/input";
import { RadioCard, RadioGroup } from "@seylo/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { toast } from "@seylo/ui/components/toast";
import { IconUsers } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../lib/api";
import { formatAgo } from "../../lib/format";
import { QueryError } from "../query-error";

type Preset = "view" | "deploy" | "full";

const presetActions: Record<Preset, readonly string[]> = {
  view: ["projects.view", "services.view", "logs.view", "metrics.view", "env.view", "domains.view"],
  deploy: [
    "projects.view",
    "services.view",
    "services.deploy",
    "services.control",
    "logs.view",
    "metrics.view",
    "env.view",
    "domains.view",
    "terminals.console",
  ],
  full: ["*"],
};

/** Preset actions that really exist, so a renamed action never breaks the share. */
function actionsFor(preset: Preset): string[] {
  if (preset === "full") return ["*"];
  const known = new Set<string>(grantableActions(allOps, "project"));
  return presetActions[preset].filter((action) => known.has(action));
}

export function ProjectPeople({ projectId, onShare }: { projectId: string; onShare: () => void }) {
  const list = useOp(grants.listByProject, { projectId });
  if (list.isError) return <QueryError error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <DataTable
      aria-label={t("project.people.title")}
      loading={list.isPending}
      rows={list.data?.grants ?? []}
      getRowId={(row) => row.grant.id}
      empty={
        <EmptyState
          compact
          icon={<IconUsers />}
          title={t("project.people.empty")}
          description={t("project.people.emptyHint")}
          action={
            <Button size="sm" variant="primary" onClick={onShare}>
              {t("project.share")}
            </Button>
          }
        />
      }
      columns={[
        {
          id: "person",
          header: t("project.people.person"),
          cell: (row) => (
            <span className="flex items-center gap-2.5">
              <Avatar name={row.user.name || row.user.email} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{row.user.name || row.user.email}</span>
                {row.user.name && <span className="truncate text-xs text-muted-foreground">{row.user.email}</span>}
              </span>
            </span>
          ),
          sortValue: (row) => row.user.email,
        },
        {
          id: "scope",
          header: t("project.people.scope"),
          cell: (row) =>
            row.grant.scopeType === "project" ? (
              <Chip tone="blue">{t("project.people.wholeProject")}</Chip>
            ) : (
              <Chip tone="track">{row.grant.scopeName}</Chip>
            ),
        },
        {
          id: "actions",
          header: t("project.people.access"),
          cell: (row) =>
            row.grant.actions.includes("*")
              ? t("project.people.everything")
              : t("project.people.actionCount", { count: row.grant.actions.length }),
        },
        {
          id: "updated",
          header: t("project.people.updated"),
          cell: (row) => formatAgo(row.grant.updatedAt),
          sortValue: (row) => row.grant.updatedAt,
          hideOnMobile: true,
        },
      ]}
    />
  );
}

export function ShareDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const people = useOp(users.list, { status: "active" }, { enabled: open });
  const [userId, setUserId] = useState("");
  const [preset, setPreset] = useState<Preset>("view");
  const share = useOpMutation(grants.setOnProject, {
    onSuccess: () => {
      toast.success(t("project.people.shared"));
      onOpenChange(false);
      setUserId("");
    },
  });
  const members = people.data?.users.filter((user) => user.role === "member") ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    share.mutate({ projectId, userId, actions: actionsFor(preset) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("project.people.shareTitle")}</DialogTitle>
            <DialogDescription>{t("project.people.shareHint")}</DialogDescription>
          </div>
          {people.isError ? (
            <QueryError error={people.error} />
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="share-user">{t("project.people.person")}</Label>
              <Select value={userId} onValueChange={setUserId} disabled={members.length === 0}>
                <SelectTrigger id="share-user" loading={people.isPending}>
                  <SelectValue placeholder={t("project.people.noMembers")} />
                </SelectTrigger>
                <SelectContent>
                  {members.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name ? `${user.name} (${user.email})` : user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <RadioGroup value={preset} onValueChange={(value) => setPreset(value as Preset)} aria-label={t("project.people.access")}>
            <RadioCard value="view" title={t("project.people.presetView")} description={t("project.people.presetViewHint")} />
            <RadioCard value="deploy" title={t("project.people.presetDeploy")} description={t("project.people.presetDeployHint")} />
            <RadioCard value="full" title={t("project.people.presetFull")} description={t("project.people.presetFullHint")} />
          </RadioGroup>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            {t("project.people.inviteHint")} <Link to="/settings/people">{t("project.people.inviteLink")}</Link>
          </p>
          {share.error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {errorMessage(share.error, t("common.unknownError"))}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={userId === "" || share.isPending}>
              {t("project.share")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
