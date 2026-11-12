import { expect, test } from "bun:test";
import { domainNeedsSetup, domainsNeedingSetup } from "./needs-setup";

const base = {
  auto: false,
  forward: null,
  dnsStatus: "ok",
  origin: "node",
  certificate: { status: "valid" },
} as unknown as Parameters<typeof domainNeedsSetup>[0];
const d = (over: Record<string, unknown>) => ({ ...base, ...over }) as typeof base;

test("custom domains whose DNS, origin or certificate still need the owner count; the rest do not", () => {
  expect(domainNeedsSetup(base)).toBe(false);
  expect(domainNeedsSetup(d({ dnsStatus: "missing" }))).toBe(true);
  expect(domainNeedsSetup(d({ dnsStatus: "wrongTarget" }))).toBe(true);
  expect(domainNeedsSetup(d({ origin: "elsewhere" }))).toBe(true);
  // Behind Cloudflare: counts until requests through it reach the node.
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: undefined }))).toBe(true);
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: "node" }))).toBe(false);
  expect(domainNeedsSetup(d({ certificate: { status: "failed" } }))).toBe(true);
  // A certificate on its way is not the owner's job; automatic domains and forwards never count.
  expect(domainNeedsSetup(d({ certificate: { status: "pending" } }))).toBe(false);
  expect(domainNeedsSetup(d({ auto: true, dnsStatus: "missing" }))).toBe(false);
  expect(domainNeedsSetup(d({ forward: { url: "https://x.example" }, dnsStatus: "missing" }))).toBe(false);
  expect(domainsNeedingSetup([base, d({ dnsStatus: "missing" }), d({ origin: "elsewhere" })])).toBe(2);
  expect(domainsNeedingSetup(undefined)).toBe(0);
});

test("a domain with no route counts when the domain is the problem, not while its service has not deployed", () => {
  // Behind Cloudflare without an origin check: the deploy is what is missing, not the record.
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: undefined, noRoute: { reason: "notDeployed" } }))).toBe(false);
  expect(domainNeedsSetup(d({ noRoute: { reason: "stackParent" } }))).toBe(true);
  expect(domainNeedsSetup(d({ noRoute: { reason: "cronService" } }))).toBe(true);
  expect(domainNeedsSetup(d({ noRoute: { reason: "routeWriteFailed", error: "x" } }))).toBe(true);
});
