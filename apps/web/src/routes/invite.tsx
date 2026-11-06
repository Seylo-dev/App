// Accepting an invite (/invite?t=<token>, the link invites.create makes).
// invites.preview says who invited whom to what. A new person picks a
// password and is signed in by invites.accept; someone who already has an
// account signs in first and then accepts while signed in.

import { auth, invites, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Card } from "@seylo/ui/components/card";
import { Chip } from "@seylo/ui/components/chip";
import { Input, Label } from "@seylo/ui/components/input";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthFrame } from "../components/auth/auth-frame";
import { QueryError } from "../components/query-error";
import { t } from "../i18n/t";
import { errorMessage, queryClient } from "../lib/api";
import { formatExpiresIn } from "../lib/format";

type LoginResult = OpOutput<typeof invites.accept>;

export const Route = createFileRoute("/invite")({
  validateSearch: (search: Record<string, unknown>): { t?: string } =>
    typeof search.t === "string" && search.t.length > 0 && search.t.length <= 200 ? { t: search.t } : {},
  component: InvitePage,
});

function InvitePage() {
  const { t: token = "" } = Route.useSearch();
  const navigate = useNavigate();
  const preview = useOp(invites.preview, { token }, { enabled: token !== "", retry: false });
  const viewer = useOp(auth.whoami, {}, { retry: false });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const accept = useOpMutation(invites.accept, {
    onSuccess: (result: LoginResult) => {
      if (result.status === "secondFactor") {
        // An existing account with 2FA: the sign-in page finishes it, then the invite is accepted there.
        void navigate({ to: "/login", search: { redirect: `/invite?t=${encodeURIComponent(token)}` } });
        return;
      }
      queryClient.setQueryData(opQueryKey(auth.whoami, {}), { viewer: result.viewer, via: "session" });
      void queryClient.invalidateQueries();
      void navigate({ to: "/" });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept.mutate(signedIn ? { token } : { token, name: name.trim() || undefined, password });
  };

  const data = preview.data;
  const signedIn = viewer.isSuccess;
  const sameAccount = signedIn && data?.email !== null && viewer.data?.viewer.email === data?.email;
  const redirect = `/invite?t=${encodeURIComponent(token)}`;

  return (
    <AuthFrame>
      <Card className="w-full max-w-[460px] gap-4 p-7">
        {!token ? (
          <Invalid />
        ) : preview.isPending ? (
          <Skeleton className="h-40" />
        ) : preview.isError ? (
          <QueryError error={preview.error} onRetry={() => void preview.refetch()} />
        ) : !data?.valid ? (
          <Invalid />
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("invite.title")}</h1>
              <p className="m-0 text-[13.5px] leading-normal text-muted-foreground">
                {t(data.invitedBy ? "invite.byWhom" : "invite.byNobody", {
                  who: data.invitedBy ?? "",
                  email: data.email ?? "",
                  role: data.role ? t(`roles.${data.role}`) : "",
                })}
                {data.expiresAt && ` ${t("invite.expires", { expires: formatExpiresIn(data.expiresAt) })}`}
              </p>
            </div>
            {data.grants.length > 0 && (
              <ul aria-label={t("invite.access")} className="m-0 flex list-none flex-col gap-1.5 rounded-control bg-raised p-3 text-[13px]">
                {data.grants.map((grant) => (
                  <li key={`${grant.scopeType}:${grant.scopeId}`} className="flex items-center gap-2">
                    <Chip tone={grant.scopeType === "project" ? "blue" : "track"}>{t(`invite.scope.${grant.scopeType}`)}</Chip>
                    <span className="truncate font-medium">{grant.scopeName}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {grant.actions.includes("*")
                        ? t("project.people.everything")
                        : t("project.people.actionCount", { count: grant.actions.length })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {data.accountExists && !sameAccount ? (
              <>
                <p className="m-0 text-[13px] text-ink-strong">{t("invite.signInFirst", { email: data.email ?? "" })}</p>
                <Button variant="primary" asChild>
                  <Link to="/login" search={{ redirect }}>
                    {t("auth.submit")}
                  </Link>
                </Button>
              </>
            ) : (
              <>
                {!signedIn && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="invite-name">{t("invite.name")}</Label>
                      <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="invite-password">{t("auth.password")}</Label>
                      <Input
                        id="invite-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder={t("setup.passwordHint")}
                        minLength={10}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                    </div>
                  </>
                )}
                {accept.error && (
                  <p role="alert" className="m-0 text-[13px] text-destructive">
                    {errorMessage(accept.error, t("common.unknownError"))}
                  </p>
                )}
                <Button type="submit" variant="primary" disabled={accept.isPending || (!signedIn && password.length < 10)}>
                  {signedIn ? t("invite.accept") : t("invite.createAndAccept")}
                </Button>
              </>
            )}
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}

function Invalid() {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">{t("invite.invalidTitle")}</h1>
      <p className="m-0 text-[13.5px] text-muted-foreground">{t("invite.invalidHint")}</p>
    </div>
  );
}
