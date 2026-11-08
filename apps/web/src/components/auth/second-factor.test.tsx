import { expect, test } from "bun:test";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { SecondFactor } from "./second-factor";

const challenge = (hasRecoveryCodes: boolean) => ({
  ticket: "ticket",
  methods: ["totp" as const, "recovery" as const],
  hasRecoveryCodes,
  expiresAt: "2026-11-08T10:05:00.000Z",
});

const render = (hasRecoveryCodes: boolean) =>
  renderStatic(() => <SecondFactor challenge={challenge(hasRecoveryCodes)} onDone={() => {}} onBack={() => {}} />);

/** How renderToStaticMarkup writes text. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

test("offers a recovery code while the account has one", async () => {
  const markup = await render(true);
  expect(markup).toContain(html(t("auth.secondFactor.useRecovery")));
  expect(markup).not.toContain(html(t("auth.secondFactor.noRecoveryCodes")));
});

test("without recovery codes it says whom to ask instead of offering one", async () => {
  const markup = await render(false);
  expect(markup).not.toContain(html(t("auth.secondFactor.useRecovery")));
  expect(markup).toContain(html(t("auth.secondFactor.noRecoveryCodes")));
  // The authenticator step itself is unchanged.
  expect(markup).toContain(html(t("auth.secondFactor.totpHint")));
});
