// A custom domain whose certificate is on its way: while the panel has not
// seen the domain reach the node, the row says the certificate waits for
// DNS (not Generating SSL certificate) and how to fix the record; every
// such note has Check again. Before, the Cloudflare-proxied note had no
// way to check again at all.

import { expect, test } from "bun:test";
import { renderStatic } from "../../../test/render";
import { type Domain, DomainRow } from "./domain-row";

const day = 86_400_000;

const domain = (over: Partial<Domain> = {}): Domain => ({
  id: "dom0000000000001",
  serviceId: "svc0000000000001",
  host: "verifly.cc",
  pathPrefix: "/",
  stripPrefix: false,
  targetPort: 3000,
  https: "acme",
  redirectToHttps: true,
  auto: false,
  primary: true,
  forward: null,
  middlewares: { basicAuth: null, ipAllowList: [], rateLimit: null, redirects: [] },
  dnsStatus: "proxied",
  dnsCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  pointsTo: ["159.195.35.141"],
  certificate: { status: "pending", expiresAt: null, issuer: null, error: null },
  liveAt: null,
  url: "https://verifly.cc",
  createdAt: new Date(Date.now() - 2 * day).toISOString(),
  updatedAt: new Date(Date.now() - day).toISOString(),
  ...over,
});

const render = (d: Domain) => renderStatic(() => <DomainRow serviceId={d.serviceId} serviceName="web" domain={d} onEdit={() => {}} />);

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

test("behind Cloudflare's proxy, waiting for DNS: the record to set, plain HTTP meanwhile, and Check again", async () => {
  const html = await render(
    domain({ certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true } }),
  );
  const shown = text(html);
  expect(shown).toContain("Certificate waits for DNS");
  expect(shown).not.toContain("Generating SSL certificate");
  expect(shown).toContain("point that record in Cloudflare at 159.195.35.141");
  expect(shown).toContain("Until then verifly.cc is served over plain HTTP.");
  expect(html).toContain('data-testid="certificate-waiting"');
  expect(html).toMatch(/<button[^>]*>.*?Check again<\/button>/);
});

test("a certificate generating behind the proxy before the origin check reached the node has Check again too", async () => {
  const shown = text(await render(domain()));
  expect(shown).toContain("Generating SSL certificate");
  expect(shown).toContain("cannot see where its record points");
  expect(shown).toContain("Check again");
});

test("a failure from before the wait shows the wait, not the failure", async () => {
  const shown = text(
    await render(
      domain({
        certificate: { status: "failed", expiresAt: null, issuer: null, error: "acme: 403 unauthorized", waitingForDns: true },
      }),
    ),
  );
  expect(shown).toContain("Certificate waits for DNS");
  expect(shown).not.toContain("Certificate failed");
  expect(shown).not.toContain("Regenerate certificate");
});

test("a record still missing says the certificate waits for it", async () => {
  const shown = text(
    await render(
      domain({ dnsStatus: "missing", certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true } }),
    ),
  );
  expect(shown).toContain("Waiting for DNS");
  expect(shown).toContain("The certificate is asked for once this record points at the node");
  expect(shown).toContain("Check now");
});

test("once the origin check reached the node and the certificate is new, no note yet", async () => {
  const shown = text(
    await render(domain({ origin: "node", originCheckedAt: new Date().toISOString(), createdAt: new Date().toISOString() })),
  );
  expect(shown).toContain("Generating SSL certificate");
  expect(shown).not.toContain("Check again");
});
