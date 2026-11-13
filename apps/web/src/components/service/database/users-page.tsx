// The Users tab of a database: its login users as the engine lists them
// (databases.users), with the main user first (the one Seylo signs in
// with), a new user with an access preset, new passwords, renames,
// deletes and another user as the main one. The Connection tab's Change
// links land here with ?change=name or ?change=password, which opens the
// main user's dialog. Seylo keeps only the main user's password: others
// show once. After a change to the main user, the services that
// reference the database are listed with a link to redeploy each.

import { databases, type OpOutput, services } from "@seylo/ops";
import { useOp, useOpMutation } from "@seylo/ops/react";
import { Callout } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Checkbox } from "@seylo/ui/components/checkbox";
import { Chip } from "@seylo/ui/components/chip";
import { ConfirmDialog } from "@seylo/ui/components/confirm-dialog";
import { CopyField } from "@seylo/ui/components/copy-field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@seylo/ui/components/dialog";
import { Input } from "@seylo/ui/components/input";
import { ActionsMenu } from "@seylo/ui/components/menu-items";
import { SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Segmented, SegmentedItem } from "@seylo/ui/components/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { ButtonSkeleton, LoadingRegion, Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { toast } from "@seylo/ui/components/toast";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { t } from "../../../i18n/t";
import { databaseUserMenuEntries } from "../../menus/row-items";
import { copyWithToast, RowMenu } from "../../menus/row-menu";
import { Field } from "../field";
import { useInvalidate } from "../invalidate";
import { MutationError, OpErrorNote, retryOp } from "../op-state";
import type { ServiceDetail } from "../use-service";
import { maskUrlPassword } from "./mask-url";

type Users = OpOutput<typeof databases.users>;
type User = Users["users"][number];
type Preset = Users["presets"][number];
type MainResult = {
  user: string;
  password: string | null;
  affectedServiceIds: string[];
  deploymentId: string | null;
  warning: string | null;
};

type Open =
  | { kind: "create" }
  | { kind: "password"; user: User }
  | { kind: "mainPassword" }
  | { kind: "known" }
  | { kind: "rename"; user: User }
  | { kind: "renameMain" }
  | { kind: "switch"; existing: User | null }
  | { kind: "delete"; user: User };

/** The user's reference in the ops: its host (MySQL) and auth database (MongoDB) with its name. */
function refOf(u: User) {
  return {
    name: u.name,
    ...(u.host !== null ? { host: u.host } : {}),
    ...(u.authDatabase !== null ? { authDatabase: u.authDatabase } : {}),
  };
}

const keyOf = (u: User) => `${u.name}@${u.host ?? ""}@${u.authDatabase ?? ""}`;

/** Passwords Seylo accepts: what the contracts allow. */
const passwordPattern = /^[A-Za-z0-9._~-]{12,128}$/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function UsersPage({ service }: { service: ServiceDetail }) {
  const users = useOp(databases.users, { serviceId: service.id }, { retry: retryOp });
  // Not strict: the route's validateSearch already keeps only name or password.
  const search: { change?: "name" | "password" } = useSearch({ strict: false });
  const navigate = useNavigate({ from: "/p/$projectId/s/$serviceId/users" });
  const [open, setOpen] = useState<Open | null>(null);
  const [result, setResult] = useState<MainResult | null>(null);
  const data = users.data;
  // The database's own database ("shop"), which the access presets are about; the service name until it loads.
  const info = useOp(databases.get, { serviceId: service.id }, { retry: retryOp });
  const database = info.data?.internal.database || service.name;

  // The Connection tab's Change links: the main user's dialog, once the list says how its name changes.
  useEffect(() => {
    if (!search.change || !data) return;
    // Not while it cannot change (stopped, the node away): the tab says why instead.
    const main = data.users.find((u) => u.main);
    const allowed =
      search.change === "password" ? main?.can.passwordChange : data.main.rename === "switch" ? data.signIn === "ok" : main?.can.rename;
    if (allowed) setOpen(search.change === "password" ? mainPasswordDialog(data) : mainNameDialog(data));
    void navigate({ search: (prev) => ({ ...prev, change: undefined }), replace: true });
  }, [search.change, data, navigate]);

  if (users.isPending) return <UsersSkeleton />;
  if (users.isError) return <OpErrorNote error={users.error} />;
  const list = users.data;
  const close = () => setOpen(null);
  const done = (r: MainResult) => {
    setOpen(null);
    setResult(r);
  };
  return (
    <div className="flex flex-col gap-4">
      {list.signIn === "offline" && <Callout tone="neutral">{list.message ?? t("serviceDatabaseUsers.offline")}</Callout>}
      {list.signIn === "failed" && (
        <Callout
          tone="warning"
          action={
            list.engine !== "clickhouse" && (
              <Button size="sm" onClick={() => setOpen(list.engine === "mongo" ? { kind: "known" } : { kind: "mainPassword" })}>
                {list.engine === "mongo" ? t("serviceDatabaseUsers.enterWorking") : t("serviceDatabaseUsers.setAgain")}
              </Button>
            )
          }
        >
          {list.message ?? t("serviceDatabaseUsers.signInFailed")}
        </Callout>
      )}
      {list.signIn === "ok" && list.message && <Callout tone="warning">{list.message}</Callout>}
      <section
        aria-label={t("serviceDatabaseUsers.title")}
        className="flex flex-col gap-3.5 rounded-card bg-card px-5 pt-[18px] pb-5 shadow-card"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-[15px] font-semibold">{t("serviceDatabaseUsers.title")}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t("serviceDatabaseUsers.count", { count: list.users.length })}</span>
          <span className="ml-auto flex items-center gap-2">
            {list.main.canSwitch && list.signIn === "ok" && (
              <Button size="sm" className="bg-muted shadow-none" onClick={() => setOpen({ kind: "switch", existing: null })}>
                {t("serviceDatabaseUsers.switchMain")}
              </Button>
            )}
            {list.canCreate && list.signIn === "ok" && (
              <Button size="sm" variant="primary" onClick={() => setOpen({ kind: "create" })}>
                <IconPlus size={14} stroke={2.2} />
                {t("serviceDatabaseUsers.newUser")}
              </Button>
            )}
          </span>
        </div>
        <p className="m-0 text-[12.5px] leading-normal text-ink-strong">{t("serviceDatabaseUsers.subtitle", { name: service.name })}</p>
        {list.notice && (
          <p role="note" className="m-0 rounded-control bg-muted px-3 py-2.5 text-[12.5px] leading-normal text-ink-strong">
            {list.notice}
          </p>
        )}
        <ul aria-label={t("serviceDatabaseUsers.title")} className="m-0 flex list-none flex-col gap-2 p-0">
          {list.users.map((u) => (
            <UserRow key={keyOf(u)} users={list} user={u} database={database} onOpen={setOpen} />
          ))}
        </ul>
        {list.truncated && <p className="m-0 text-[12.5px] text-muted-foreground">{t("serviceDatabaseUsers.truncated")}</p>}
      </section>
      {open?.kind === "create" && <NewUserDialog service={service} users={list} database={database} onClose={close} />}
      {open?.kind === "password" && <PasswordDialog service={service} user={open.user} onClose={close} />}
      {open?.kind === "mainPassword" && <MainPasswordDialog service={service} users={list} onClose={close} onDone={done} />}
      {open?.kind === "known" && <KnownPasswordDialog service={service} users={list} onClose={close} />}
      {open?.kind === "rename" && <RenameDialog service={service} users={list} user={open.user} onClose={close} />}
      {open?.kind === "renameMain" && <RenameMainDialog service={service} users={list} onClose={close} onDone={done} />}
      {open?.kind === "switch" && (
        <SwitchDialog service={service} users={list} database={database} existing={open.existing} onClose={close} onDone={done} />
      )}
      {open?.kind === "delete" && <DeleteDialog service={service} users={list} user={open.user} onClose={close} />}
      {result && <MainResultDialog service={service} result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function mainPasswordDialog(users: Users): Open {
  return users.signIn === "failed" && users.engine === "mongo" ? { kind: "known" } : { kind: "mainPassword" };
}

/** The main user's name: rename in place or with a restart, else another user as the main one. */
function mainNameDialog(users: Users): Open {
  if (users.main.rename === "switch") return { kind: "switch", existing: null };
  return users.main.rename === "none" ? { kind: "mainPassword" } : { kind: "renameMain" };
}

export function UsersSkeleton() {
  return (
    <LoadingRegion label={t("common.loading")} className="flex flex-col gap-4">
      <SectionCardSkeleton titleWidth="w-20" description="w-96" actions={<ButtonSkeleton size="sm" className="w-24" />}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-control bg-field px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <SkeletonText className="w-40 text-[13px]" />
              <SkeletonText className="w-56 text-xs" />
            </div>
            <Skeleton className="size-8 rounded-control" />
          </div>
        ))}
      </SectionCardSkeleton>
    </LoadingRegion>
  );
}

function accessLabel(access: User["access"], database: string): string {
  return t(`serviceDatabaseUsers.access.${access}`, { database });
}

function UserRow({ users, user, database, onOpen }: { users: Users; user: User; database: string; onOpen: (open: Open) => void }) {
  const offline = users.signIn !== "ok";
  const menuItems = !user.main && (user.can.passwordChange || user.can.rename || user.can.delete || user.can.makeMain);
  const menu = menuItems
    ? databaseUserMenuEntries(user, {
        canSwitch: users.main.canSwitch,
        act: (action) => {
          if (action === "password") onOpen({ kind: "password", user });
          else if (action === "rename") onOpen({ kind: "rename", user });
          else if (action === "makeMain") onOpen({ kind: "switch", existing: user });
          else if (action === "copyName") void copyWithToast(user.name);
          else onOpen({ kind: "delete", user });
        },
      })
    : [];
  return (
    <RowMenu entries={menu} aria-label={t("serviceDatabaseUsers.more", { name: user.name })}>
      <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control bg-field px-3 py-2.5 transition-colors duration-200 data-[state=open]:bg-muted">
        <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <b className="font-mono text-[13px] font-medium [overflow-wrap:anywhere]">
              {user.name}
              {user.host !== null && <span className="text-muted-foreground">@{user.host}</span>}
            </b>
            {user.main && <Chip tone="blue">{t("serviceDatabaseUsers.main")}</Chip>}
            {user.system && <Chip tone="gray">{t("serviceDatabaseUsers.system")}</Chip>}
            {user.locked && <Chip tone="amber">{t("serviceDatabaseUsers.locked")}</Chip>}
            {user.authDatabase !== null && user.authDatabase !== "admin" && (
              <Chip tone="track" mono>
                {t("serviceDatabaseUsers.authDatabase", { database: user.authDatabase })}
              </Chip>
            )}
          </span>
          <span className="text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
            {user.main && <span className="text-ink-strong">{t("serviceDatabaseUsers.mainLine")} · </span>}
            <span title={user.roles.join("\n") || undefined}>{accessLabel(user.access, database)}</span>
            {user.ownsObjects ? ` · ${t("serviceDatabaseUsers.owns", { count: user.ownsObjects })}` : ""}
            {user.definerObjects ? ` · ${t("serviceDatabaseUsers.definers", { count: user.definerObjects })}` : ""}
            {user.roles.length > 0 && user.access === "custom" && ` · ${user.roles.slice(0, 3).join(", ")}`}
          </span>
          {!user.main && user.why && !menuItems && <span className="text-xs leading-normal text-muted-foreground">{user.why}</span>}
        </span>
        {user.main ? (
          <span className="flex shrink-0 flex-wrap items-center gap-2">
            {user.can.passwordChange && (
              <Button size="sm" className="bg-card shadow-none" onClick={() => onOpen(mainPasswordDialog(users))}>
                {t("serviceDatabaseUsers.changePassword")}
              </Button>
            )}
            {users.main.rename !== "none" && !offline && (
              <Button size="sm" className="bg-card shadow-none" onClick={() => onOpen(mainNameDialog(users))}>
                {t("serviceDatabaseUsers.changeName")}
              </Button>
            )}
            {offline && users.main.rename === "restart" && user.can.rename && (
              <Button size="sm" className="bg-card shadow-none" onClick={() => onOpen({ kind: "renameMain" })}>
                {t("serviceDatabaseUsers.changeName")}
              </Button>
            )}
          </span>
        ) : (
          menuItems && (
            <ActionsMenu
              entries={menu}
              trigger={
                <Button
                  size="icon"
                  className="size-8 shrink-0 rounded-control bg-card shadow-none"
                  aria-label={t("serviceDatabaseUsers.more", { name: user.name })}
                >
                  <IconDots size={15} />
                </Button>
              }
            />
          )
        )}
      </li>
    </RowMenu>
  );
}

/** Generated, or one the person types; null while what is typed is not a password Seylo takes. */
function PasswordChoice({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null | undefined;
  onChange: (password: string | null | undefined) => void;
}) {
  // undefined: generated; a string: typed (null while it does not fit).
  const [own, setOwn] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        value={own ? "own" : "generate"}
        onValueChange={(v) => {
          setOwn(v === "own");
          onChange(v === "own" ? (passwordPattern.test(typed) ? typed : null) : undefined);
        }}
        aria-label={t("serviceDatabaseUsers.password.choice")}
        tone="muted"
        className="self-start"
      >
        <SegmentedItem value="generate">{t("serviceDatabaseUsers.password.generate")}</SegmentedItem>
        <SegmentedItem value="own">{t("serviceDatabaseUsers.password.own")}</SegmentedItem>
      </Segmented>
      {own && (
        <Field label={t("serviceDatabaseUsers.password.label")} htmlFor={id} hint={t("serviceDatabaseUsers.password.ownHint")}>
          <Input
            id={id}
            className="font-mono"
            autoComplete="new-password"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              onChange(passwordPattern.test(e.target.value) ? e.target.value : null);
            }}
            aria-invalid={value === null && typed !== ""}
          />
        </Field>
      )}
    </div>
  );
}

function NewUserDialog({
  service,
  users,
  database,
  onClose,
}: {
  service: ServiceDetail;
  users: Users;
  database: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Preset>(users.presets.includes("readWrite") ? "readWrite" : (users.presets[0] ?? "readOnly"));
  const [host, setHost] = useState("%");
  const [advanced, setAdvanced] = useState(false);
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const create = useOpMutation(databases.createUser, { onSuccess: () => invalidate(databases.users) });

  const hint = (p: Preset) =>
    users.engine === "postgres" && (p === "readOnly" || p === "readWrite")
      ? t(`serviceDatabaseUsers.presetHint.${p}Postgres`, { database })
      : t(`serviceDatabaseUsers.presetHint.${p}`, { database });
  if (create.data) {
    const made = create.data;
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex flex-col gap-3">
          <DialogTitle>{t("serviceDatabaseUsers.create.doneTitle", { user: made.user.name })}</DialogTitle>
          <DialogDescription>{t("serviceDatabaseUsers.create.doneBody")}</DialogDescription>
          <CopyField value={made.password} aria-label={t("serviceDatabaseUsers.password.label")} />
          <span className="text-[12.5px] font-medium text-ink-strong">{t("serviceDatabaseUsers.create.internalUrl")}</span>
          <CopyField
            value={made.internalUrl}
            secret
            masked={maskUrlPassword(made.internalUrl)}
            aria-label={t("serviceDatabaseUsers.create.internalUrl")}
            className="-mt-1.5"
          />
          {made.exposedUrl && (
            <>
              <span className="text-[12.5px] font-medium text-ink-strong">{t("serviceDatabaseUsers.create.exposedUrl")}</span>
              <CopyField
                value={made.exposedUrl}
                secret
                masked={maskUrlPassword(made.exposedUrl)}
                aria-label={t("serviceDatabaseUsers.create.exposedUrl")}
                className="-mt-1.5"
              />
            </>
          )}
          <Button variant="primary" className="self-end" onClick={onClose}>
            {t("service.close")}
          </Button>
        </DialogContent>
      </Dialog>
    );
  }
  const valid = namePattern.test(name) && password !== null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-[10%]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            create.mutate({
              serviceId: service.id,
              name,
              access,
              ...(users.hosts && host.trim() && host.trim() !== "%" ? { host: host.trim() } : {}),
              ...(password ? { password } : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceDatabaseUsers.create.title")}</DialogTitle>
            <DialogDescription>{t("serviceDatabaseUsers.create.body", { name: service.name })}</DialogDescription>
          </div>
          <Field label={t("serviceDatabaseUsers.create.name")} htmlFor="du-name" hint={t("serviceDatabaseUsers.create.nameHint")}>
            <Input id="du-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
          </Field>
          <Field label={t("serviceDatabaseUsers.create.access")} htmlFor="du-access" hint={hint(access)}>
            <Select value={access} onValueChange={(v) => setAccess(v as Preset)}>
              <SelectTrigger id="du-access" aria-label={t("serviceDatabaseUsers.create.access")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {users.presets.map((p) => (
                  <SelectItem key={p} value={p}>
                    {accessLabel(p, database)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <PasswordChoice id="du-password" value={password} onChange={setPassword} />
          {users.hosts &&
            (advanced ? (
              <Field label={t("serviceDatabaseUsers.create.host")} htmlFor="du-host" hint={t("serviceDatabaseUsers.create.hostHint")}>
                <Input id="du-host" className="max-w-[260px] font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
              </Field>
            ) : (
              <button
                type="button"
                className="cursor-pointer self-start border-0 bg-transparent p-0 text-[13px] font-medium text-link"
                onClick={() => setAdvanced(true)}
              >
                {t("serviceDatabaseUsers.create.advanced")}
              </button>
            ))}
          <MutationError error={create.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!valid || create.isPending}>
              {t("serviceDatabaseUsers.create.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A new password for another user than the main one: Seylo shows it once. */
function PasswordDialog({ service, user, onClose }: { service: ServiceDetail; user: User; onClose: () => void }) {
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const set = useOpMutation(databases.setUserPassword);
  if (set.data)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex flex-col gap-3">
          <DialogTitle>{t("serviceDatabaseUsers.setPassword.doneTitle", { user: user.name })}</DialogTitle>
          <DialogDescription>{t("serviceDatabaseUsers.setPassword.doneBody")}</DialogDescription>
          <CopyField value={set.data.password} aria-label={t("serviceDatabaseUsers.password.label")} />
          <Button variant="primary" className="self-end" onClick={onClose}>
            {t("service.close")}
          </Button>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (password === null) return;
            set.mutate({ serviceId: service.id, user: refOf(user), ...(password ? { password } : {}) });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceDatabaseUsers.setPassword.title", { user: user.name })}</DialogTitle>
            <DialogDescription>{t("serviceDatabaseUsers.setPassword.body")}</DialogDescription>
          </div>
          <PasswordChoice id="dp-password" value={password} onChange={setPassword} />
          <MutationError error={set.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={password === null || set.isPending}>
              {t("serviceDatabaseUsers.setPassword.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const restartEngines = new Set(["clickhouse", "dragonfly", "redis", "valkey", "keydb"]);

/** The main user's password: the old Reset password, typed name to confirm. */
function MainPasswordDialog({
  service,
  users,
  onClose,
  onDone,
}: {
  service: ServiceDetail;
  users: Users;
  onClose: () => void;
  onDone: (r: MainResult) => void;
}) {
  const invalidate = useInvalidate();
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const finished = useRef(false);
  const set = useOpMutation(databases.setUserPassword, {
    onSuccess: (res) => {
      finished.current = true;
      invalidate(databases.connection, databases.users, databases.get);
      onDone({ user: users.main.user, ...res });
    },
  });
  const main = users.users.find((u) => u.main);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && !finished.current && onClose()}
      title={t("serviceDatabaseUsers.mainPassword.title")}
      description={t("serviceDatabaseUsers.mainPassword.body", { user: users.main.user })}
      confirmText={service.name}
      confirmLabel={t("serviceDatabaseUsers.mainPassword.submit")}
      destructive
      confirmDisabled={password === null}
      onConfirm={() =>
        set
          .mutateAsync({ serviceId: service.id, user: main ? refOf(main) : { name: users.main.user }, ...(password ? { password } : {}) })
          .then(() => undefined)
      }
    >
      <PasswordChoice id="dm-password" value={password} onChange={setPassword} />
      {restartEngines.has(users.engine) && (
        <p className="m-0 text-[12.5px] leading-normal text-ink-strong">
          {t("serviceDatabaseUsers.mainPassword.restarts", { engine: t(`service.kind.${users.engine}`) })}
        </p>
      )}
    </ConfirmDialog>
  );
}

/** When the stored login stopped working: the password that works, stored after Seylo signed in with it. */
function KnownPasswordDialog({ service, users, onClose }: { service: ServiceDetail; users: Users; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [password, setPassword] = useState("");
  const set = useOpMutation(databases.setUserPassword, {
    onSuccess: () => {
      invalidate(databases.connection, databases.users);
      toast.success(t("serviceDatabaseUsers.passwordChanged", { user: users.main.user }));
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({ serviceId: service.id, user: { name: users.main.user }, password, known: true });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceDatabaseUsers.known.title")}</DialogTitle>
            <DialogDescription>{t("serviceDatabaseUsers.known.body")}</DialogDescription>
          </div>
          <Field label={t("serviceDatabaseUsers.password.label")} htmlFor="dk-password">
            <Input
              id="dk-password"
              type="password"
              className="font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </Field>
          <MutationError error={set.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!passwordPattern.test(password) || set.isPending}>
              {t("serviceDatabaseUsers.known.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ service, users, user, onClose }: { service: ServiceDetail; users: Users; user: User; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(user.name);
  const [host, setHost] = useState(user.host ?? "%");
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const [acceptDefiners, setAcceptDefiners] = useState(false);
  const rename = useOpMutation(databases.renameUser, {
    onSuccess: (res) => {
      invalidate(databases.users);
      if (!res.password) {
        toast.success(t("serviceDatabaseUsers.renamed", { from: user.name, to: res.user.name }));
        onClose();
      }
    },
  });
  if (rename.data?.password)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex flex-col gap-3">
          <DialogTitle>{t("serviceDatabaseUsers.setPassword.doneTitle", { user: rename.data.user.name })}</DialogTitle>
          <DialogDescription>{t("serviceDatabaseUsers.setPassword.doneBody")}</DialogDescription>
          <CopyField value={rename.data.password} aria-label={t("serviceDatabaseUsers.password.label")} />
          <Button variant="primary" className="self-end" onClick={onClose}>
            {t("service.close")}
          </Button>
        </DialogContent>
      </Dialog>
    );
  const definers = user.definerObjects ?? 0;
  const changed = name !== user.name || (users.hosts && host !== user.host);
  const valid = namePattern.test(name) && changed && password !== null && (definers === 0 || acceptDefiners);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const pw = generatedOr(password, user.passwordForRename);
            rename.mutate({
              serviceId: service.id,
              user: refOf(user),
              name,
              ...(users.hosts && host !== user.host ? { host } : {}),
              ...(pw ? { password: pw } : {}),
              ...(acceptDefiners ? { acceptOrphanDefiners: true } : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{t("serviceDatabaseUsers.renameUser.title", { user: user.name })}</DialogTitle>
            <DialogDescription>{t("serviceDatabaseUsers.renameUser.body")}</DialogDescription>
          </div>
          <Field label={t("serviceDatabaseUsers.renameUser.newName")} htmlFor="dr-name" hint={t("serviceDatabaseUsers.create.nameHint")}>
            <Input id="dr-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" />
          </Field>
          {users.hosts && (
            <Field label={t("serviceDatabaseUsers.create.host")} htmlFor="dr-host" hint={t("serviceDatabaseUsers.create.hostHint")}>
              <Input id="dr-host" className="max-w-[260px] font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
          )}
          {user.passwordForRename && (
            <>
              <p role="note" className="m-0 rounded-control bg-muted px-3 py-2.5 text-[12.5px] leading-normal text-ink-strong">
                {users.engine === "mongo"
                  ? t("serviceDatabaseUsers.renameUser.needsPassword")
                  : t("serviceDatabaseUsers.renameUser.needsPasswordMd5")}
              </p>
              <PasswordChoice id="dr-password" value={password} onChange={setPassword} />
            </>
          )}
          {definers > 0 && (
            <Callout tone="warning">
              <span className="flex flex-col gap-2">
                {t("serviceDatabaseUsers.renameUser.definers", { count: definers })}
                <label htmlFor="dr-definers" className="flex cursor-pointer items-center gap-2.5">
                  <Checkbox id="dr-definers" checked={acceptDefiners} onCheckedChange={(v) => setAcceptDefiners(v === true)} />
                  {t("serviceDatabaseUsers.renameUser.acceptDefiners")}
                </label>
              </span>
            </Callout>
          )}
          <MutationError error={rename.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t("service.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!valid || rename.isPending}>
              {t("serviceDatabaseUsers.renameUser.submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Generated passwords need no field: passwordForRename asks one to be generated when left on Generate. */
function generatedOr(password: string | null | undefined, needed: boolean): string | undefined {
  if (password) return password;
  return needed ? randomPassword() : undefined;
}

function randomPassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  let out = "";
  for (const b of bytes) {
    if (b < 248) out += alphabet[b % alphabet.length];
    if (out.length === 32) break;
  }
  return out.length === 32 ? out : randomPassword();
}

/** The main user's new name: in place (Postgres, MySQL and MariaDB other than root) or with a restart (ClickHouse). */
function RenameMainDialog({
  service,
  users,
  onClose,
  onDone,
}: {
  service: ServiceDetail;
  users: Users;
  onClose: () => void;
  onDone: (r: MainResult) => void;
}) {
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [withPassword, setWithPassword] = useState(users.users.find((u) => u.main)?.passwordForRename ?? false);
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const [restart, setRestart] = useState(true);
  const finished = useRef(false);
  const rename = useOpMutation(databases.renameUser, {
    onSuccess: (res) => {
      finished.current = true;
      invalidate(databases.connection, databases.users, databases.get);
      onDone({
        user: res.user.name,
        password: res.password,
        affectedServiceIds: res.affectedServiceIds,
        deploymentId: res.deploymentId,
        warning: res.warning,
      });
    },
  });
  const main = users.users.find((u) => u.main);
  const needsPassword = main?.passwordForRename ?? false;
  const definers = main?.definerObjects ?? 0;
  const [acceptDefiners, setAcceptDefiners] = useState(false);
  const valid =
    namePattern.test(name) && name !== users.main.user && (!withPassword || password !== null) && (definers === 0 || acceptDefiners);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && !finished.current && onClose()}
      title={t("serviceDatabaseUsers.renameMain.title")}
      description={t("serviceDatabaseUsers.renameMain.body", { user: users.main.user })}
      confirmText={service.name}
      confirmLabel={t("serviceDatabaseUsers.renameMain.submit")}
      destructive
      confirmDisabled={!valid}
      onConfirm={() => {
        const pw = withPassword ? generatedOr(password, true) : undefined;
        return rename
          .mutateAsync({
            serviceId: service.id,
            user: main ? refOf(main) : { name: users.main.user },
            name,
            ...(pw ? { password: pw } : {}),
            ...(users.engine === "postgres" && !restart ? { deploy: false } : {}),
            ...(acceptDefiners ? { acceptOrphanDefiners: true } : {}),
          })
          .then(() => undefined);
      }}
    >
      <Field label={t("serviceDatabaseUsers.renameUser.newName")} htmlFor="drm-name" hint={t("serviceDatabaseUsers.create.nameHint")}>
        <Input id="drm-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      {needsPassword ? (
        <p role="note" className="m-0 text-[12.5px] leading-normal text-ink-strong">
          {t("serviceDatabaseUsers.renameUser.needsPasswordMd5")}
        </p>
      ) : (
        <label htmlFor="drm-with-password" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="drm-with-password" checked={withPassword} onCheckedChange={(v) => setWithPassword(v === true)} />
          {t("serviceDatabaseUsers.renameMain.newPassword")}
        </label>
      )}
      {withPassword && <PasswordChoice id="drm-password" value={password} onChange={setPassword} />}
      {users.engine === "postgres" && (
        <label htmlFor="drm-restart" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="drm-restart" checked={restart} onCheckedChange={(v) => setRestart(v === true)} />
          {t("serviceDatabaseUsers.renameMain.restartPostgres")}
        </label>
      )}
      {users.main.rename === "restart" && (
        <p role="note" className="m-0 text-[12.5px] leading-normal text-ink-strong">
          {t("serviceDatabaseUsers.renameMain.restartClickHouse")}
        </p>
      )}
      {definers > 0 && (
        <label htmlFor="drm-definers" className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-normal text-ink-strong">
          <Checkbox id="drm-definers" className="mt-0.5" checked={acceptDefiners} onCheckedChange={(v) => setAcceptDefiners(v === true)} />
          {t("serviceDatabaseUsers.renameUser.definers", { count: definers })} {t("serviceDatabaseUsers.renameUser.acceptDefiners")}
        </label>
      )}
    </ConfirmDialog>
  );
}

/** Another user as the main one: a new one with full rights, or an existing one with a new password. */
function SwitchDialog({
  service,
  users,
  database,
  existing,
  onClose,
  onDone,
}: {
  service: ServiceDetail;
  users: Users;
  database: string;
  existing: User | null;
  onClose: () => void;
  onDone: (r: MainResult) => void;
}) {
  const invalidate = useInvalidate();
  const candidates = users.users.filter((u) => u.can.makeMain);
  const [mode, setMode] = useState<"new" | "existing">(existing ? "existing" : "new");
  const [picked, setPicked] = useState(existing ? keyOf(existing) : "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const [grantAdmin, setGrantAdmin] = useState(false);
  const [dropOld, setDropOld] = useState(false);
  const finished = useRef(false);
  const target = candidates.find((u) => keyOf(u) === picked) ?? null;
  const change = useOpMutation(databases.switchMainUser, {
    onSuccess: (res) => {
      finished.current = true;
      invalidate(databases.connection, databases.users, databases.get);
      onDone(res);
    },
  });
  const mysql = users.engine === "mysql" || users.engine === "mariadb";
  const rootMain = mysql && users.main.user === "root";
  const needsGrant = mode === "existing" && target !== null && target.access !== "serverAdmin";
  // Removing the old main user is a delete: what runs as it (DEFINER) stops working.
  const [acceptDefiners, setAcceptDefiners] = useState(false);
  const definers = mysql && dropOld ? (users.users.find((u) => u.main)?.definerObjects ?? 0) : 0;
  const valid =
    password !== null &&
    (mode === "new" ? namePattern.test(name) : target !== null && (!needsGrant || grantAdmin)) &&
    (definers === 0 || acceptDefiners);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && !finished.current && onClose()}
      title={t("serviceDatabaseUsers.switch.title")}
      description={
        <>
          {t("serviceDatabaseUsers.switch.body")}
          {rootMain && ` ${t("serviceDatabaseUsers.switch.rootBody")}`}
        </>
      }
      confirmText={service.name}
      confirmLabel={t("serviceDatabaseUsers.switch.submit")}
      destructive
      confirmDisabled={!valid}
      onConfirm={() =>
        change
          .mutateAsync({
            serviceId: service.id,
            name: mode === "new" ? name : (target?.name ?? ""),
            ...(mode === "existing" ? { existing: true } : {}),
            ...(password ? { password } : {}),
            ...(needsGrant && grantAdmin ? { grantAdmin: true } : {}),
            ...(dropOld ? { oldUser: "delete" as const } : {}),
            ...(definers > 0 && acceptDefiners ? { acceptOrphanDefiners: true } : {}),
          })
          .then(() => undefined)
      }
    >
      {candidates.length > 0 && (
        <Segmented
          value={mode}
          onValueChange={(v) => setMode(v === "existing" ? "existing" : "new")}
          aria-label={t("serviceDatabaseUsers.switch.which")}
          tone="muted"
          className="self-start"
        >
          <SegmentedItem value="new">{t("serviceDatabaseUsers.switch.newUser")}</SegmentedItem>
          <SegmentedItem value="existing">{t("serviceDatabaseUsers.switch.existingUser")}</SegmentedItem>
        </Segmented>
      )}
      {mode === "new" ? (
        <Field label={t("serviceDatabaseUsers.create.name")} htmlFor="ds-name" hint={t("serviceDatabaseUsers.create.nameHint")}>
          <Input id="ds-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
      ) : (
        <Field label={t("serviceDatabaseUsers.switch.pick")} htmlFor="ds-user" hint={t("serviceDatabaseUsers.switch.existingNote")}>
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger id="ds-user" aria-label={t("serviceDatabaseUsers.switch.pick")}>
              <SelectValue placeholder={t("serviceDatabaseUsers.switch.pick")} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((u) => (
                <SelectItem key={keyOf(u)} value={keyOf(u)}>
                  {u.name}
                  {u.host !== null ? `@${u.host}` : ""} · {accessLabel(u.access, database)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {needsGrant && (
        <label htmlFor="ds-grant" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="ds-grant" checked={grantAdmin} onCheckedChange={(v) => setGrantAdmin(v === true)} />
          {t("serviceDatabaseUsers.switch.grantAdmin")}
        </label>
      )}
      <PasswordChoice id="ds-password" value={password} onChange={setPassword} />
      {mysql && <p className="m-0 text-[12.5px] leading-normal text-ink-strong">{t("serviceDatabaseUsers.switch.rootPassword")}</p>}
      {users.engine !== "postgres" && (
        <label htmlFor="ds-drop" className="flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-strong">
          <Checkbox id="ds-drop" checked={dropOld} onCheckedChange={(v) => setDropOld(v === true)} />
          {rootMain
            ? t("serviceDatabaseUsers.switch.deleteRoot")
            : `${t("serviceDatabaseUsers.switch.oldUser", { user: users.main.user })}: ${t("serviceDatabaseUsers.switch.deleteOld")}`}
        </label>
      )}
      {definers > 0 && (
        <label htmlFor="ds-definers" className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-normal text-ink-strong">
          <Checkbox id="ds-definers" className="mt-0.5" checked={acceptDefiners} onCheckedChange={(v) => setAcceptDefiners(v === true)} />
          {t("serviceDatabaseUsers.deleteUser.definers", { count: definers })}
        </label>
      )}
    </ConfirmDialog>
  );
}

function DeleteDialog({ service, users, user, onClose }: { service: ServiceDetail; users: Users; user: User; onClose: () => void }) {
  const invalidate = useInvalidate();
  const owns = user.ownsObjects ?? 0;
  const definers = user.definerObjects ?? 0;
  const [reassign, setReassign] = useState(false);
  const [acceptDefiners, setAcceptDefiners] = useState(false);
  const remove = useOpMutation(databases.deleteUser, {
    onSuccess: () => {
      invalidate(databases.users);
      toast.success(t("serviceDatabaseUsers.deleteUser.done", { user: user.name }));
    },
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("serviceDatabaseUsers.deleteUser.title", { user: user.host !== null ? `${user.name}@${user.host}` : user.name })}
      description={t("serviceDatabaseUsers.deleteUser.body")}
      confirmLabel={t("serviceDatabaseUsers.deleteUser.submit")}
      destructive
      confirmDisabled={(owns > 0 && !reassign) || (definers > 0 && !acceptDefiners)}
      onConfirm={() => {
        return remove
          .mutateAsync({
            serviceId: service.id,
            user: refOf(user),
            ...(owns > 0 ? { reassignOwned: true } : {}),
            ...(definers > 0 ? { acceptOrphanDefiners: true } : {}),
          })
          .then(() => undefined);
      }}
    >
      {owns > 0 && (
        <label htmlFor="dd-reassign" className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-normal text-ink-strong">
          <Checkbox id="dd-reassign" className="mt-0.5" checked={reassign} onCheckedChange={(v) => setReassign(v === true)} />
          {t("serviceDatabaseUsers.deleteUser.owns", { count: owns, main: users.main.user })}
        </label>
      )}
      {definers > 0 && (
        <label htmlFor="dd-definers" className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-normal text-ink-strong">
          <Checkbox id="dd-definers" className="mt-0.5" checked={acceptDefiners} onCheckedChange={(v) => setAcceptDefiners(v === true)} />
          {t("serviceDatabaseUsers.deleteUser.definers", { count: definers })}
        </label>
      )}
    </ConfirmDialog>
  );
}

/** After a change to the main user: the password (when there is a new one), the restart, and the services to redeploy. */
function MainResultDialog({ service, result, onClose }: { service: ServiceDetail; result: MainResult; onClose: () => void }) {
  const list = useOp(services.list, { projectId: service.projectId }, { enabled: result.affectedServiceIds.length > 0 });
  const names = new Map((list.data?.services ?? []).map((s) => [s.id, s.name]));
  const title = result.password
    ? t("serviceDatabaseUsers.result.passwordTitle", { user: result.user })
    : t("serviceDatabaseUsers.result.renamedTitle", { user: result.user });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex flex-col gap-3">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {result.password && `${t("serviceDatabaseUsers.result.copyNow")} `}
          {result.affectedServiceIds.length > 0
            ? t("serviceDatabaseUsers.result.affected", { count: result.affectedServiceIds.length })
            : t("serviceDatabaseUsers.result.none")}
        </DialogDescription>
        {result.password && <CopyField value={result.password} aria-label={t("serviceDatabaseUsers.password.label")} />}
        {result.deploymentId && (
          <p className="m-0 text-[12.5px] leading-normal text-ink-strong">
            {t("serviceDatabaseUsers.result.restarting")}{" "}
            <Link
              to="/p/$projectId/s/$serviceId/deployments"
              params={{ projectId: service.projectId, serviceId: service.id }}
              className="font-medium text-link"
            >
              {t("serviceDatabaseUsers.result.deployment")}
            </Link>
          </p>
        )}
        {result.affectedServiceIds.length > 0 && (
          <ul aria-label={t("serviceDatabaseUsers.result.redeploy")} className="m-0 flex list-none flex-col gap-1.5 p-0">
            {result.affectedServiceIds.map((id) => (
              <li key={id} className="flex items-center gap-3 rounded-control bg-field px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-medium">{names.get(id) ?? id}</span>
                <Link
                  to="/p/$projectId/s/$serviceId/deployments"
                  params={{ projectId: service.projectId, serviceId: id }}
                  className="shrink-0 font-medium text-link"
                >
                  {t("serviceDatabaseUsers.result.redeploy")}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result.warning && <Callout tone="warning">{result.warning}</Callout>}
        <Button variant="primary" className="self-end" onClick={onClose}>
          {t("service.close")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
