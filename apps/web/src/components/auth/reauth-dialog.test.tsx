import { expect, test } from "bun:test";
import { auth } from "@seylo/ops";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { ReauthForm } from "./reauth-dialog";

const security = (change: Record<string, unknown>) => ({
  passwordSet: false,
  totp: { enabled: false, confirmedAt: null },
  recoveryCodesLeft: 0,
  passkeys: [],
  passkeysAvailable: false,
  github: { login: "octo", repoAccess: false, linkedAt: "2026-11-01T10:00:00.000Z" },
  githubAvailable: true,
  ...change,
});

const render = (change: Record<string, unknown>) =>
  renderStatic(
    () => <ReauthForm busy={false} setBusy={() => {}} returnTo="/settings" onDone={() => {}} onCancel={() => {}} />,
    [[auth.security, {}, security(change)]],
  );

/** How renderToStaticMarkup writes text. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

test("an account that signs in with GitHub confirms with GitHub instead of signing in again", async () => {
  const markup = await render({});
  expect(markup).toContain(html(t("auth.reauth.confirmGithub")));
  expect(markup).toContain(html(t("auth.reauth.githubHint", { login: "octo" })));
  expect(markup).not.toContain(html(t("auth.reauth.signInAgain")));
  // The only method: no switch.
  expect(markup).not.toContain('role="radiogroup"');
});

test("GitHub is one more choice next to the password", async () => {
  const markup = await render({ passwordSet: true });
  expect(markup).toContain('role="radiogroup"');
  expect(markup).toContain(`>${t("auth.reauth.methods.password")}</button>`);
  expect(markup).toContain(`>${t("auth.reauth.methods.github")}</button>`);
  // The password comes first and is the one shown.
  expect(markup).toContain('id="reauth-password"');
  expect(markup).not.toContain(html(t("auth.reauth.confirmGithub")));
});

test("without GitHub sign-in on the panel, or without a linked login, it falls back to signing in again", async () => {
  for (const change of [{ githubAvailable: false }, { github: null }]) {
    const markup = await render(change);
    expect(markup).toContain(html(t("auth.reauth.signInAgain")));
    expect(markup).not.toContain(html(t("auth.reauth.confirmGithub")));
  }
});
