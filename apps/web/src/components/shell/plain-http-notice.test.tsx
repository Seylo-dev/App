import { expect, test } from "bun:test";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { PlainHttpNoticeView } from "./plain-http-notice";

const page = { host: "203.0.113.5", port: "3000" };

/** How renderToStaticMarkup writes text. */
const html = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

test("one calm line with a link to the panel domain and a closed tunnel section", async () => {
  const markup = await renderStatic(() => <PlainHttpNoticeView page={page} canSetDomain onDismiss={() => {}} />);
  expect(markup).toContain(html(t("plainHttp.text")));
  expect(markup).toContain('href="/settings/general"');
  expect(markup).toContain(html(t("plainHttp.setDomain")));
  expect(markup).toContain(`aria-label="${t("plainHttp.dismiss")}"`);
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("ssh -L");
  // Calm: no warning tone, no alert role.
  expect(markup).not.toContain("chip-amber");
  expect(markup).not.toContain('role="alert"');
});

test("More shows the SSH tunnel for this address and port", async () => {
  const markup = await renderStatic(() => <PlainHttpNoticeView page={page} canSetDomain onDismiss={() => {}} defaultOpen />);
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain("ssh -L 3000:127.0.0.1:3000 root@203.0.113.5");
  expect(markup).toContain(html(t("plainHttp.thenOpen", { url: "http://127.0.0.1:3000" })));
  expect(markup).toContain(html(t("plainHttp.less")));
});

test("members, who cannot set the panel domain, get no link to it", async () => {
  const markup = await renderStatic(() => <PlainHttpNoticeView page={page} canSetDomain={false} onDismiss={() => {}} />);
  expect(markup).toContain(html(t("plainHttp.text")));
  expect(markup).not.toContain("/settings/general");
  expect(markup).toContain(html(t("plainHttp.more")));
});
