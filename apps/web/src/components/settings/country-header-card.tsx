// Settings > General, "Visitor country": the panel-wide switch for the
// X-Seylo-Country request header (on by default), the nodes whose agent is
// too old to add it, and a MaxMind account as the second source of the
// country database. DB-IP's licence asks for the credit at the bottom.

import { countryHeader, type OpOutput } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Button } from "@seylo/ui/components/button";
import { Input } from "@seylo/ui/components/input";
import { SectionCard, SectionCardSkeleton } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { useState } from "react";
import { t } from "../../i18n/t";
import { useSettingsMutation } from "./mutation";
import { QueryView } from "./op-state";
import { Field, FormActions, FormGrid, SettingRow } from "./page";
import { FieldSkeleton, SettingRowSkeleton } from "./skeletons";

type Settings = OpOutput<typeof countryHeader.get>;

export function CountryHeaderCard() {
  const query = useOp(countryHeader.get, {});
  return (
    <QueryView
      query={query}
      skeleton={
        <SectionCardSkeleton titleWidth="w-28" description="w-96">
          <SettingRowSkeleton titleWidth="w-56" />
          <FormGrid>
            <FieldSkeleton labelWidth="w-24" />
            <FieldSkeleton labelWidth="w-24" />
          </FormGrid>
        </SectionCardSkeleton>
      }
    >
      {(data) => <CountryHeaderForm key={`${data.maxmindAccountId}|${data.maxmindLicenseKeySet}`} data={data} />}
    </QueryView>
  );
}

function CountryHeaderForm({ data }: { data: Settings }) {
  const toggle = useSettingsMutation(countryHeader.update, { invalidates: [countryHeader.get], success: t("settings.saved") });
  const saveAccount = useSettingsMutation(countryHeader.update, { invalidates: [countryHeader.get], success: t("settings.saved") });
  const [accountId, setAccountId] = useState(data.maxmindAccountId ?? "");
  const [licenseKey, setLicenseKey] = useState("");
  const enabled = toggle.isPending && toggle.variables?.enabled !== undefined ? toggle.variables.enabled : data.enabled;
  const outdated = data.nodes.filter((n) => !n.supported);

  const idError = accountId !== "" && !/^[0-9]{1,12}$/.test(accountId) ? t("settings.country.accountIdInvalid") : null;
  const keyError =
    licenseKey !== "" && !/^[A-Za-z0-9_]{6,128}$/.test(licenseKey)
      ? t("settings.country.licenseKeyInvalid")
      : licenseKey !== "" && accountId === ""
        ? t("settings.country.licenseKeyNeedsId")
        : null;
  const dirty = accountId !== (data.maxmindAccountId ?? "") || licenseKey !== "";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (idError || keyError) return;
    saveAccount.mutate({
      maxmindAccountId: accountId === "" ? null : accountId,
      ...(licenseKey !== "" ? { maxmindLicenseKey: licenseKey } : {}),
    });
  }

  return (
    <SectionCard
      title={t("settings.country.title")}
      description={t("settings.country.description", { header: countryHeader.countryHeaderName })}
    >
      <SettingRow
        title={t("settings.country.toggle")}
        description={t("settings.country.toggleHint")}
        control={
          <Switch
            checked={enabled}
            disabled={toggle.isPending}
            onCheckedChange={(on) => toggle.mutate({ enabled: on })}
            aria-label={t("settings.country.toggle")}
          />
        }
      />
      {enabled && outdated.length > 0 && (
        <p className="m-0 text-[13px] text-chip-amber-fg">
          {t("settings.country.outdated", { nodes: outdated.map((n) => n.name).join(", "), version: countryHeader.countryHeaderMinAgent })}
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("settings.country.maxmindTitle")}</span>
          <span className="text-[12.5px] text-muted-foreground">{t("settings.country.maxmindHint")}</span>
        </div>
        <FormGrid>
          <Field label={t("settings.country.accountId")} error={idError} htmlFor="country-maxmind-id">
            <Input
              id="country-maxmind-id"
              inputMode="numeric"
              autoComplete="off"
              value={accountId}
              maxLength={12}
              onChange={(e) => setAccountId(e.target.value.trim())}
            />
          </Field>
          <Field
            label={t("settings.country.licenseKey")}
            hint={data.maxmindLicenseKeySet ? t("settings.country.licenseKeySet") : undefined}
            error={keyError}
            htmlFor="country-maxmind-key"
          >
            <Input
              id="country-maxmind-key"
              type="password"
              autoComplete="off"
              value={licenseKey}
              maxLength={128}
              placeholder={data.maxmindLicenseKeySet ? "••••••••" : ""}
              onChange={(e) => setLicenseKey(e.target.value.trim())}
            />
          </Field>
        </FormGrid>
        <FormActions>
          {data.maxmindLicenseKeySet && (
            <Button
              type="button"
              variant="ghost"
              disabled={saveAccount.isPending}
              onClick={() => saveAccount.mutate({ maxmindAccountId: null, maxmindLicenseKey: null })}
            >
              {t("settings.country.removeAccount")}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!dirty || saveAccount.isPending || !!idError || !!keyError}>
            {saveAccount.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </FormActions>
      </form>
      <p className="m-0 text-xs text-muted-foreground">
        {t("settings.country.creditBefore")}{" "}
        <a href={countryHeader.countryDataAttribution.url} target="_blank" rel="noreferrer" className="text-link hover:text-link-hover">
          {countryHeader.countryDataAttribution.text}
        </a>
        {t("settings.country.creditAfter")}
      </p>
    </SectionCard>
  );
}
