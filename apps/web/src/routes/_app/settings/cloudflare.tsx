// Settings > Cloudflare: the global Cloudflare Tunnel token that services in
// token mode use when they have none of their own, and how the Cloudflare
// DNS link works (no API token is ever asked for).

import { tunnels } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Alert } from "@seylo/ui/components/alert";
import { Button } from "@seylo/ui/components/button";
import { Chip } from "@seylo/ui/components/chip";
import { Input } from "@seylo/ui/components/input";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Skeleton, SkeletonText } from "@seylo/ui/components/skeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { formatRelative } from "../../../components/settings/format";
import { useSettingsMutation } from "../../../components/settings/mutation";
import { QueryView } from "../../../components/settings/op-state";
import { Field, FormActions, SettingsPage } from "../../../components/settings/page";
import { FieldSkeleton, FormActionsSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";

export const Route = createFileRoute("/_app/settings/cloudflare")({
  component: CloudflarePage,
});

function CloudflarePage() {
  const query = useOp(tunnels.getSettings, {});
  const [token, setToken] = useState("");
  const save = useSettingsMutation(tunnels.setSettings, {
    invalidates: [tunnels.getSettings],
    success: (out) => (out.tokenSet ? t("settings.cloudflare.saved") : t("settings.cloudflare.removed")),
    onSuccess: () => setToken(""),
  });
  const tooShort = token.trim() !== "" && token.trim().length < 20;

  return (
    <SettingsPage title={t("settings.cloudflare.title")} subtitle={t("settings.cloudflare.subtitle")}>
      <SectionCard title={t("settings.cloudflare.tunnelTitle")} description={t("settings.cloudflare.tunnelDescription")}>
        <QueryView
          query={query}
          className="flex flex-col gap-3"
          skeleton={
            <>
              <div className="flex items-center gap-2">
                <Skeleton className="h-[22px] w-24 rounded-chip" />
                <SkeletonText className="w-28 text-[13px]" />
              </div>
              <FieldSkeleton labelWidth="w-24" />
              <FormActionsSkeleton />
            </>
          }
        >
          {(data) => (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim().length >= 20) save.mutate({ token: token.trim() });
              }}
            >
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                {data.tokenSet ? (
                  <Chip tone="green">{t("settings.cloudflare.tokenSet")}</Chip>
                ) : (
                  <Chip tone="gray">{t("settings.cloudflare.noToken")}</Chip>
                )}
                {data.updatedAt && (
                  <span className="text-muted-foreground">
                    {t("settings.cloudflare.updated", { when: formatRelative(data.updatedAt) })}
                  </span>
                )}
              </div>
              <Field
                label={data.tokenSet ? t("settings.cloudflare.replace") : t("settings.cloudflare.token")}
                hint={t("settings.cloudflare.tokenHint")}
                error={tooShort ? t("settings.cloudflare.tooShort") : null}
                htmlFor="cf-token"
              >
                <Input
                  id="cf-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  className="font-mono text-[12.5px]"
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
              <FormActions>
                {data.tokenSet && (
                  <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ token: null })}>
                    {t("settings.remove")}
                  </Button>
                )}
                <Button type="submit" variant="primary" disabled={token.trim().length < 20 || save.isPending}>
                  {t("settings.save")}
                </Button>
              </FormActions>
            </form>
          )}
        </QueryView>
      </SectionCard>
      <SectionCard title={t("settings.cloudflare.dnsTitle")}>
        <Alert tone="info">{t("settings.cloudflare.dnsDescription")}</Alert>
      </SectionCard>
    </SettingsPage>
  );
}
