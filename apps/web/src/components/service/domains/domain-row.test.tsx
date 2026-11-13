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
import { domainNeedsSetup } from "./needs-setup";

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

const render = (d: Domain) =>
  renderStatic(() => <DomainRow projectId="prj0000000000001" serviceId={d.serviceId} serviceName="web" domain={d} onEdit={() => {}} />);

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

// A domain with no route on its node used to read "Certificate waits for
// Cloudflare" (or for DNS) with "Cloudflare proxy -> <node IP>" beside it,
// as if the record were the problem, for as long as the service had not
// deployed. The row now says why there is no route, and checks nothing.
const shop = { host: "shop.example.com", url: "https://shop.example.com", pointsTo: ["203.0.113.10"], certificate: waitingCert };

test("a service that has not deployed yet: why, with its Deployments tab, and nothing about DNS or Cloudflare", async () => {
  const html = await render(domain({ ...shop, noRoute: { reason: "notDeployed" } }));
  const shown = text(html);
  expect(shown).toContain("Not deployed yet");
  expect(shown).toContain(
    "web has not deployed yet: its domains go live, and their certificates are asked for, once a deployment goes live.",
  );
  expect(html).toContain('href="/p/prj0000000000001/s/svc0000000000001/deployments"');
  expect(shown).not.toContain("Certificate waits for");
  expect(shown).not.toContain("Check again");
  expect(shown).not.toContain("Regenerate certificate");
  // The record in Cloudflare is still named as it is: it may well be right.
  expect(shown).toContain("Cloudflare proxy → 203.0.113.10");
  // Not a link while nothing serves it.
  expect(html).not.toContain('href="https://shop.example.com"');
});

test("its first deployment on its way says so", async () => {
  const shown = text(await render(domain({ ...shop, noRoute: { reason: "notDeployed", deploymentId: "dep0000000000001" } })));
  expect(shown).toContain("Waiting for the first deploy");
  expect(shown).toContain("web is deploying for the first time");
});

test("a record still missing on a service that has not deployed: the deploy first, the record to create still shown", async () => {
  const shown = text(await render(domain({ ...shop, dnsStatus: "missing", noRoute: { reason: "notDeployed" } })));
  expect(shown).toContain("Not deployed yet");
  expect(shown).not.toContain("Waiting for DNS");
  expect(shown).toContain("Check now");
});

test("a compose stack and a cron service: where the domain belongs", async () => {
  let shown = text(await render(domain({ ...shop, noRoute: { reason: "stackParent" } })));
  expect(shown).toContain("No route");
  expect(shown).toContain("web is a compose stack, which runs no container of its own, so this domain routes nowhere.");
  expect(shown).toContain("Add it on the Domains tab of the stack member that serves it, then remove it here.");
  shown = text(await render(domain({ ...shop, noRoute: { reason: "cronService" } })));
  expect(shown).toContain("web is a cron service: it runs on its schedule and serves no requests");
});

test("a node that could not write the routes: the node and its error", async () => {
  const html = await render(
    domain({
      ...shop,
      noRoute: {
        reason: "routeWriteFailed",
        nodeId: "nod0000000000001",
        nodeName: "node-1",
        error: "invalid route: the host belongs to another service: shop.example.com (service other)",
      },
    }),
  );
  const shown = text(html);
  expect(shown).toContain("No route on node-1");
  expect(shown).toContain(
    "node-1 could not write this service's routes: invalid route: the host belongs to another service: shop.example.com (service other)",
  );
  expect(shown).toContain("tries again every 10 seconds");
  expect(shown).not.toContain("Certificate waits for Cloudflare");
  expect(html).toContain('data-reason="routeWriteFailed"');
});

// The owner's www (0.2.15): proxied, live with a valid certificate, and no origin stored. The Domains tab
// counted it and the row said nothing. Now, while the panel is still checking, the DNS chip's tooltip says so
// and nothing counts; once its checks have not reached the node for 30 minutes the row says why.
const live = {
  host: "www.example.com",
  url: "https://www.example.com",
  pointsTo: ["203.0.113.10"],
  primary: false,
  certificate: {
    status: "valid" as const,
    expiresAt: new Date(Date.now() + 80 * day).toISOString(),
    issuer: "Let's Encrypt (R11)",
    error: null,
  },
  liveAt: new Date(Date.now() - day).toISOString(),
};
const unknownFor = (minutes: number) => ({
  origin: "unknown" as const,
  originCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  originUnknownSince: new Date(Date.now() - minutes * 60_000).toISOString(),
});
const chipTitle = (html: string) =>
  (html.match(/<span[^>]*data-testid="dns-chip"[^>]*>/)?.[0].match(/title="([^"]*)"/)?.[1] ?? "").replace(/&#x27;/g, "'");

test("a live domain behind Cloudflare whose origin is still being checked: the chip's tooltip says so, no note", async () => {
  for (const d of [domain(live), domain({ ...live, ...unknownFor(5) })]) {
    const html = await render(d);
    expect(chipTitle(html)).toStartWith("Checking that requests reach 203.0.113.10...");
    expect(html).toContain('data-origin="checking"');
    expect(html).not.toContain('data-testid="origin-unknown-note"');
    expect(text(html)).not.toContain("Check again");
  }
});

test("not reached for 30 minutes: an amber chip, and why on the row with Check again", async () => {
  let html = await render(domain({ ...live, ...unknownFor(45) }));
  let shown = text(html);
  expect(html).toContain('data-origin="unknown"');
  expect(chipTitle(html)).toStartWith(
    "Requests through Cloudflare have not reached 203.0.113.10 in the panel's checks for over 30 minutes.",
  );
  expect(html).toContain('data-testid="origin-unknown-note"');
  expect(shown).toContain(
    "Requests to www.example.com through Cloudflare have not reached 203.0.113.10 in the panel's checks for over 30 minutes",
  );
  expect(html).toMatch(/<button[^>]*>.*?Check again<\/button>/);

  // Cloudflare's own reason, when its answer gave one.
  html = await render(domain({ ...live, ...unknownFor(45), originReason: "cloudflareUnreachable" }));
  shown = text(html);
  expect(html).toContain('data-reason="cloudflareUnreachable"');
  expect(shown).toContain("Cloudflare cannot reach the node on port 443/80. Its record for www.example.com must point at 203.0.113.10");
  expect(shown).not.toContain("in the panel's checks for over 30 minutes");

  // A certificate still waiting says it in its own note: one note, not two.
  html = await render(domain({ ...live, ...unknownFor(45), liveAt: null, certificate: waitingCert }));
  expect(html).not.toContain('data-testid="origin-unknown-note"');
  expect(html).toContain('data-testid="pending-cert-note"');
});

test("every row the Domains tab counts says why on the row, with a way to check or try again", async () => {
  const counted: [Domain, RegExp][] = [
    [domain({ ...live, dnsStatus: "missing", certificate: waitingCert, liveAt: null }), /Add this record/],
    [domain({ ...live, dnsStatus: "wrongTarget", certificate: waitingCert, liveAt: null }), /Add this record/],
    [
      domain({ ...live, origin: "elsewhere", originCheckedAt: new Date().toISOString() }),
      /Requests through Cloudflare reach another server now/,
    ],
    [
      domain({ ...live, certificate: { status: "failed", expiresAt: null, issuer: null, error: "acme: 403 unauthorized" }, liveAt: null }),
      /acme: 403 unauthorized/,
    ],
    [domain({ ...live, ...unknownFor(45) }), /have not reached 203\.0\.113\.10 in the panel's checks/],
    [domain({ ...live, noRoute: { reason: "stackParent" } }), /web is a compose stack/],
  ];
  for (const [d, why] of counted) {
    expect(domainNeedsSetup(d)).toBe(true);
    const shown = text(await render(d));
    expect(shown).toMatch(why);
    if (!d.noRoute) expect(shown).toMatch(/Check again|Check now|Regenerate certificate/);
  }
});
