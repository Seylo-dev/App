// A custom domain whose certificate is on its way: while the panel has not
// seen the domain reach the node, the row says the certificate waits for
// DNS (not Generating SSL certificate) and how to fix the record; every
// such note has Check again. Before, the Cloudflare-proxied note had no
// way to check again at all. Behind Cloudflare's proxy it waits for
// Cloudflare instead, and says what Cloudflare answered the panel's check
// when that tells why (before, every such domain read "Certificate waits
// for DNS" with the same general note, whatever stopped it).

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

test("behind Cloudflare's proxy, waiting for DNS: the record to set, Cloudflare's settings that stop the check, and Check again", async () => {
  const html = await render(
    domain({ certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true } }),
  );
  const shown = text(html);
  // The record in Cloudflare is set: what it waits for is the check through Cloudflare.
  expect(shown).toContain("Certificate waits for Cloudflare");
  expect(shown).not.toContain("Certificate waits for DNS");
  expect(shown).not.toContain("Generating SSL certificate");
  expect(shown).toContain("point that record in Cloudflare at 159.195.35.141");
  // The record may be right already: Full (strict) refuses the node's certificate over Always Use HTTPS's redirect.
  expect(shown).toContain("If it already does and SSL/TLS is on Full (strict), turn off Always Use HTTPS");
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
  expect(shown).toContain("Certificate waits for Cloudflare");
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

const waitingCert = { status: "pending" as const, expiresAt: null, issuer: null, error: null, waitingForDns: true };
const checkedNow = { originCheckedAt: new Date().toISOString() };

test("a record still missing keeps Certificate waits for DNS", async () => {
  const shown = text(await render(domain({ dnsStatus: "missing", certificate: waitingCert })));
  expect(shown).toContain("Waiting for DNS");
  expect(shown).not.toContain("Certificate waits for Cloudflare");
});

test("behind Cloudflare, what Cloudflare answered the check: Full (strict), out of reach, a 404", async () => {
  // 526 or 525: the node's temporary certificate is refused.
  let html = await render(domain({ certificate: waitingCert, origin: "unknown", originReason: "cloudflareCertificate", ...checkedNow }));
  let shown = text(html);
  expect(shown).toContain("Certificate waits for Cloudflare");
  expect(shown).toContain(
    "Cloudflare's SSL mode Full (strict) refuses the node's temporary certificate until Let's Encrypt issues one: set SSL/TLS to Full for a few minutes, or turn off Always Use HTTPS, then Check again.",
  );
  expect(html).toContain('data-reason="cloudflareCertificate"');
  // Not the general sentence besides.
  expect(shown).not.toContain("cannot see where its record points");
  expect(html).toMatch(/<button[^>]*>.*?Check again<\/button>/);

  // 521 or 522: Cloudflare cannot connect.
  shown = text(await render(domain({ certificate: waitingCert, origin: "unknown", originReason: "cloudflareUnreachable", ...checkedNow })));
  expect(shown).toContain("Cloudflare cannot reach the node on port 443/80.");
  expect(shown).toContain("must point at 159.195.35.141");

  // Cloudflare's security answered in the node's place (a challenge, a WAF block): not another server.
  html = await render(domain({ certificate: waitingCert, origin: "unknown", originReason: "cloudflareChallenge", ...checkedNow }));
  shown = text(html);
  expect(shown).toContain("Certificate waits for Cloudflare");
  expect(shown).toContain("Cloudflare's security answered the check with a challenge or a block instead of passing it to the node");
  expect(shown).toContain("Let requests to /.well-known/ on verifly.cc through");
  expect(shown).not.toContain("Cloudflare proxy, not this node");
  expect(html).toContain('data-reason="cloudflareChallenge"');

  // 404 while the node may not have the domain yet.
  shown = text(await render(domain({ certificate: waitingCert, origin: "unknown", originReason: "notFound", ...checkedNow })));
  expect(shown).toContain("get 404 from the server they reach");

  // 404 with the node's route in place: another server answers, and the help below the row says the 404 too.
  html = await render(domain({ certificate: waitingCert, origin: "elsewhere", originReason: "notFound", ...checkedNow }));
  shown = text(html);
  expect(shown).toContain("Cloudflare proxy, not this node");
  expect(html).toContain('data-testid="origin-reason"');
  expect(shown).toContain("get 404 from the server they reach");

  // No reason: the general note, as before.
  shown = text(await render(domain({ certificate: waitingCert, origin: "unknown", ...checkedNow })));
  expect(shown).toContain("If it already does and SSL/TLS is on Full (strict), turn off Always Use HTTPS");
});

test("once the origin check reached the node and the certificate is new, no note yet", async () => {
  const shown = text(
    await render(domain({ origin: "node", originCheckedAt: new Date().toISOString(), createdAt: new Date().toISOString() })),
  );
  expect(shown).toContain("Generating SSL certificate");
  expect(shown).not.toContain("Check again");
});

test("a slow certificate behind Cloudflare names what stops Let's Encrypt, not Always Use HTTPS or Full (strict)", async () => {
  const shown = text(await render(domain({ origin: "node", ...checkedNow })));
  expect(shown).toContain(
    "Let's Encrypt checks http://verifly.cc/.well-known/acme-challenge/, which Always Use HTTPS leaves alone: in Cloudflare, let /.well-known/ through its security",
  );
  expect(shown).toContain("with a Redirect Rule or Page Rule that sends every request to https, set SSL/TLS to Full, not Full (strict)");
  expect(shown).not.toContain("turn off Always Use HTTPS");
});
