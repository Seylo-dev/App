// One person's sheet: name and email, role, the projects and services they
// can reach (members only; owners and admins need no grants), and disable
// or remove. Role rules (only owners touch owners, nobody changes their own
// role) are enforced by the panel; the sheet only hides what cannot work.

import { type auth, grants as grantOps, type OpOutput, users } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Avatar } from "@seylo/ui/components/avatar";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { Input } from "@seylo/ui/components/input";
import { KeyValue } from "@seylo/ui/components/key-value";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@seylo/ui/components/sheet";
import { useState } from "react";
import { t } from "../../../i18n/t";
import { ActionPicker } from "../action-picker";
import { compactActions, expandActions, grantable, summarizeActions } from "../actions";
import { formatDateTime, formatRelative } from "../format";
import { type GrantDraft, ScopeName, ScopePicker, scopeKey } from "../grant-scopes";
import { invalidateOps, useSettingsMutation } from "../mutation";
import { QueryView } from "../op-state";
import { Field, FormActions } from "../page";

type User = OpOutput<typeof users.get>["user"];
type Grant = OpOutput<typeof users.get>["grants"][number];
type RoleName = OpOutput<typeof auth.whoami>["viewer"]["role"];

const refresh = [users.list, users.get, grantOps.listByUser];

export function UserSheet({
  userId,
  viewer,
  onOpenChange,
}: {
  userId: string | null;
  viewer: { id: string; role: RoleName };
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={userId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="max-w-xl">
        {userId && <UserDetail userId={userId} viewer={viewer} onClose={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function UserDetail({ userId, viewer, onClose }: { userId: string; viewer: { id: string; role: RoleName }; onClose: () => void }) {
  const query = useOp(users.get, { userId });
  return (
    <QueryView query={query} className="p-5">
      {({ user, grants }) => <UserBody user={user} grants={grants} viewer={viewer} onClose={onClose} />}
    </QueryView>
  );
}

function UserBody({
  user,
  grants,
  viewer,
  onClose,
}: {
  user: User;
  grants: Grant[];
  viewer: { id: string; role: RoleName };
  onClose: () => void;
}) {
  const self = user.id === viewer.id;
  // Admins manage admins and members, never owners; only owners hand out the owner role.
  const canManage = !self && (viewer.role === "owner" || user.role !== "owner");
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const update = useSettingsMutation(users.update, { invalidates: refresh, success: t("settings.saved") });
  const updateRole = useSettingsMutation(users.updateRole, { invalidates: refresh, success: t("settingsPeople.user.roleChanged") });
  const disable = useSettingsMutation(users.disable, { invalidates: refresh, success: t("settingsPeople.user.disabled") });
  const enable = useSettingsMutation(users.enable, { invalidates: refresh, success: t("settingsPeople.user.enabled") });
  const remove = useSettingsMutation(users.remove, { invalidates: [users.list], failure: false });

  const roles: RoleName[] = viewer.role === "owner" ? ["owner", "admin", "member"] : ["admin", "member"];
  const profileDirty = name.trim() !== user.name || email.trim().toLowerCase() !== user.email;

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-3">
          <Avatar name={user.name || user.email} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <SheetTitle className="truncate">{user.name || user.email}</SheetTitle>
            <SheetDescription className="truncate">{user.email}</SheetDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Chip tone={user.role === "member" ? "gray" : "blue"}>{t(`roles.${user.role}`)}</Chip>
          {user.status === "disabled" && <Chip tone="red">{t("settingsPeople.status.disabled")}</Chip>}
          {user.twoFactor && <Chip tone="green">{t("settingsPeople.users.twoFactor")}</Chip>}
          {user.githubLogin && <Chip tone="gray">GitHub @{user.githubLogin}</Chip>}
        </div>
      </SheetHeader>
      <SheetBody className="pb-5">
        <KeyValue
          items={[
            {
              label: t("settingsPeople.users.lastLogin"),
              value: user.lastLoginAt ? formatRelative(user.lastLoginAt) : t("settings.never"),
            },
            { label: t("settingsPeople.user.joined"), value: formatDateTime(user.createdAt) },
            { label: t("settingsPeople.user.passkeys"), value: String(user.passkeyCount) },
          ]}
        />

        {canManage && (
          <section className="flex flex-col gap-3">
            <h3 className="m-0 text-[13.5px] font-semibold">{t("settingsPeople.user.profile")}</h3>
            <Field label={t("settingsPeople.user.name")} htmlFor="user-name">
              <Input id="user-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t("settingsPeople.invite.email")} htmlFor="user-email">
              <Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <FormActions>
              <Button
                size="sm"
                variant="primary"
                disabled={!profileDirty || update.isPending}
                onClick={() =>
                  update.mutate({
                    userId: user.id,
                    ...(name.trim() !== user.name ? { name: name.trim() } : {}),
                    ...(email.trim().toLowerCase() !== user.email ? { email: email.trim().toLowerCase() } : {}),
                  })
                }
              >
                {t("settings.save")}
              </Button>
            </FormActions>
            <Field label={t("settingsPeople.invite.role")} hint={t(`settingsPeople.roleHints.${user.role}`)} htmlFor="user-role">
              <Select
                value={user.role}
                disabled={updateRole.isPending}
                onValueChange={(role) => updateRole.mutate({ userId: user.id, role: role as RoleName })}
              >
                <SelectTrigger id="user-role" className="sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`roles.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </section>
        )}
        {self && <Alert tone="neutral">{t("settingsPeople.user.self")}</Alert>}

        <section className="flex flex-col gap-3">
          <h3 className="m-0 text-[13.5px] font-semibold">{t("settingsPeople.user.access")}</h3>
          {user.role !== "member" ? (
            <p className="m-0 text-[13px] text-muted-foreground">{t("settingsPeople.user.everything")}</p>
          ) : (
            <GrantsList userId={user.id} grants={grants} editable={canManage} />
          )}
        </section>

        {canManage && (
          <section className="flex flex-col gap-2 border-t border-divider pt-4">
            <h3 className="m-0 text-[13.5px] font-semibold text-chip-red-fg">{t("settingsPeople.user.danger")}</h3>
            <div className="flex flex-wrap gap-2">
              {user.status === "active" ? (
                <Button size="sm" onClick={() => setConfirmDisable(true)}>
                  {t("settingsPeople.user.disable")}
                </Button>
              ) : (
                <Button size="sm" disabled={enable.isPending} onClick={() => enable.mutate({ userId: user.id })}>
                  {t("settingsPeople.user.enable")}
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={() => setConfirmRemove(true)}>
                {t("settingsPeople.user.remove")}
              </Button>
            </div>
          </section>
        )}
      </SheetBody>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t("settingsPeople.user.disableTitle", { email: user.email })}
        description={t("settingsPeople.user.disableDescription")}
        confirmLabel={t("settingsPeople.user.disable")}
        destructive
        onConfirm={() => disable.mutateAsync({ userId: user.id }).then(() => undefined)}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("settingsPeople.user.removeTitle", { email: user.email })}
        description={t("settingsPeople.user.removeDescription")}
        confirmLabel={t("settingsPeople.user.remove")}
        confirmText={user.email}
        destructive
        onConfirm={async () => {
          await remove.mutateAsync({ userId: user.id, confirmEmail: user.email });
          onClose();
        }}
      />
    </>
  );
}

/** A member's grants, each editable in place; plus a picker to add access. */
function GrantsList({ userId, grants, editable }: { userId: string; grants: Grant[]; editable: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const setOnProject = useSettingsMutation(grantOps.setOnProject, { invalidates: refresh, success: t("settingsPeople.grants.saved") });
  const setOnService = useSettingsMutation(grantOps.setOnService, { invalidates: refresh, success: t("settingsPeople.grants.saved") });
  const removeProject = useSettingsMutation(grantOps.removeFromProject, {
    invalidates: refresh,
    success: t("settingsPeople.grants.removed"),
  });
  const removeService = useSettingsMutation(grantOps.removeFromService, {
    invalidates: refresh,
    success: t("settingsPeople.grants.removed"),
  });

  async function save(scope: Pick<GrantDraft, "scopeType" | "scopeId">, actions: ReadonlySet<string>) {
    const list = compactActions(actions, grantable(scope.scopeType));
    if (list.length === 0) return;
    setBusy(true);
    try {
      if (scope.scopeType === "project") await setOnProject.mutateAsync({ projectId: scope.scopeId, userId, actions: list });
      else await setOnService.mutateAsync({ serviceId: scope.scopeId, userId, actions: list });
      setEditing(null);
    } finally {
      setBusy(false);
      await invalidateOps(refresh);
    }
  }

  function removeGrant(grant: Grant) {
    if (grant.scopeType === "project") removeProject.mutate({ projectId: grant.scopeId, userId });
    else removeService.mutate({ serviceId: grant.scopeId, userId });
  }

  return (
    <div className="flex flex-col gap-2">
      {grants.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">{t("settingsPeople.user.noAccess")}</p>}
      {grants.map((grant) => {
        const key = scopeKey(grant);
        const isEditing = editing === key;
        return (
          <div key={grant.id} className="rounded-control bg-raised px-3 py-2.5">
            <div className="flex items-center gap-2">
              <ScopeName draft={{ scopeType: grant.scopeType, scopeName: grant.scopeName, projectName: null }} />
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{summarizeActions(grant.actions)}</span>
              {editable && !isEditing && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(key);
                      setDraft(expandActions(grant.actions, grantable(grant.scopeType)));
                    }}
                  >
                    {t("settings.edit")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => removeGrant(grant)}>
                    {t("settings.remove")}
                  </Button>
                </>
              )}
            </div>
            {isEditing && (
              <div className="mt-3 flex flex-col gap-3 border-t border-divider pt-3">
                <ActionPicker available={grantable(grant.scopeType)} value={draft} onChange={setDraft} />
                <FormActions>
                  <Button size="sm" onClick={() => setEditing(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy || draft.size === 0} onClick={() => void save(grant, draft)}>
                    {t("settings.save")}
                  </Button>
                </FormActions>
              </div>
            )}
          </div>
        );
      })}
      {editable && (
        <ScopePicker
          exclude={new Set(grants.map(scopeKey))}
          addLabel={t("settingsPeople.grants.addAccess")}
          onAdd={(added) => void save(added, added.actions)}
        />
      )}
    </div>
  );
}
