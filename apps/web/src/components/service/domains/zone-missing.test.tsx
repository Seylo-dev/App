// A domain whose registrable domain does not exist. The panel used to walk
// past it to the public suffix, so the row read "Add this record where
// co.il's DNS is managed: A melaket-eg-preview.exampel ...". Now it says
// the registrable domain does not exist, with "Did you mean" when the
// panel names a likely spelling, and keeps the record (relative to the
// registrable domain) for once it exists; a domain that exists reads as
// before. Adding one keeps it and warns.

import { afterEach, expect, test } from "bun:test";
import { domains, type OpOutput } from "@seylo/ops";
import { toastStore } from "@seylo/ui/components/toast";
import { renderStatic } from "../../../test/render";
import { toastAdded, toastAutoAdded } from "./added-toast";
import { type Domain, DomainRow } from "./domain-row";

const day = 86_400_000;
const serviceId = "svc0000000000001";
const domainId = "dom0000000000001";

const domain = (over: Partial<Domain> = {}): Domain => ({
  id: domainId,
  serviceId,
  host: "melaket-eg-preview.exampel.co.il",
  pathPrefix: "/",
  stripPrefix: false,
  targetPort: 3000,
  https: "acme",
  redirectToHttps: true,
  auto: false,
  primary: true,
  forward: null,
  middlewares: { basicAuth: null, ipAllowList: [], rateLimit: null, redirects: [] },
  dnsStatus: "missing",
  dnsCheckedAt: new Date(Date.now() - 60_000).toISOString(),
  pointsTo: ["203.0.113.10"],
  certificate: { status: "pending", expiresAt: null, issuer: null, error: null, waitingForDns: true },
  liveAt: null,
  url: "https://melaket-eg-preview.exampel.co.il",
  createdAt: new Date(Date.now() - day).toISOString(),
  updatedAt: new Date(Date.now() - day).toISOString(),
  ...over,
});

type Check = OpOutput<typeof domains.checkDns>;

const missingCheck = (over: Partial<Check> = {}): Check => ({
  domainId,
  host: "melaket-eg-preview.exampel.co.il",
  status: "missing",
  message: "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.",
  expected: [{ type: "A", name: "melaket-eg-preview", value: "203.0.113.10" }],
  found: [],
  zone: null,
  registrable: "exampel.co.il",
  zoneMissing: true,
  cloudflareManaged: false,
  cloudflareDnsUrl: null,
  checkedAt: new Date().toISOString(),
  ...over,
});

const render = (d: Domain, check: Check) =>
  renderStatic(
    () => <DomainRow projectId="prj0000000000001" serviceId={serviceId} serviceName="web" domain={d} onEdit={() => {}} />,
    [[domains.checkDns, { serviceId, domainId }, check]],
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

afterEach(() => toastStore.dismiss());

test("a registrable domain that does not exist: said plainly, no 'where its DNS is managed', the record kept", async () => {
  const html = await render(domain(), missingCheck());
  const shown = text(html);
  expect(shown).toContain("exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.");
  expect(shown).not.toContain("DNS is managed");
  expect(shown).not.toContain("co.il's");
  expect(html).toContain('data-testid="zone-missing"');
  expect(html).not.toContain('data-testid="did-you-mean"');
  // The record, relative to the registrable domain, for once it exists.
  expect(shown).toContain("The record to create once it exists:");
  expect(shown).toContain("A melaket-eg-preview 203.0.113.10");
  expect(shown).toContain("Check now");
  // The panel's message is the same sentence: not twice.
  expect(shown.split("does not exist").length).toBe(2);
});

test("with a likely spelling the viewer can see: Did you mean", async () => {
  const html = await render(domain(), missingCheck({ didYouMean: "example.co.il" }));
  expect(html).toContain('data-testid="did-you-mean"');
  expect(text(html)).toContain("Check the spelling. Did you mean example.co.il?");
});

test("a domain that exists reads as before", async () => {
  const check = missingCheck({
    host: "shop.example.co.il",
    message: "No A record for shop.example.co.il yet. Create one pointing at 203.0.113.10.",
    expected: [{ type: "A", name: "shop", value: "203.0.113.10" }],
    zone: "example.co.il",
    registrable: "example.co.il",
    zoneMissing: false,
  });
  const html = await render(domain({ host: "shop.example.co.il", url: "https://shop.example.co.il" }), check);
  const shown = text(html);
  expect(shown).toContain("Add this record where example.co.il's DNS is managed:");
  expect(shown).toContain("A shop 203.0.113.10");
  expect(shown).not.toContain("does not exist");
  expect(html).not.toContain('data-testid="zone-missing"');
});

const added = (warning?: NonNullable<Domain["warning"]>) =>
  ({
    domain: { ...domain(), ...(warning ? { warning } : {}) },
    dns: missingCheck(),
  }) as OpOutput<typeof domains.add>;

test("adding a domain whose registrable domain does not exist warns, with Did you mean", () => {
  toastAdded(
    added({
      reason: "registrableMissing",
      registrable: "exampel.co.il",
      didYouMean: "example.co.il",
      message: "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.",
    }),
    "web",
  );
  const [shown] = toastStore.getSnapshot();
  expect(shown).toMatchObject({
    tone: "warning",
    title: "Domain added, but exampel.co.il does not exist.",
    description: "It is not registered, or has no name servers yet. Check the spelling. Did you mean example.co.il?",
  });
});

test("adding one without a warning is the usual toast; an automatic domain warns the same way", () => {
  toastAdded(added(), "web");
  expect(toastStore.getSnapshot()[0]).toMatchObject({ tone: "success", title: "Domain added. Create the DNS record shown on its row." });
  toastStore.dismiss();
  const auto = { ...domain({ host: "web.n2.exampel.com", auto: true }) };
  toastAutoAdded({
    ...auto,
    warning: {
      reason: "registrableMissing",
      registrable: "exampel.com",
      message: "exampel.com does not exist: it is not registered, or has no name servers yet. Check the spelling.",
    },
  });
  expect(toastStore.getSnapshot()[0]).toMatchObject({
    tone: "warning",
    title: "Domain added, but exampel.com does not exist.",
    description: "It is not registered, or has no name servers yet. Check the spelling.",
  });
  toastStore.dismiss();
  toastAutoAdded(auto);
  expect(toastStore.getSnapshot()[0]).toMatchObject({ tone: "success", title: "Automatic domain added." });
});
