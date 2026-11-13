import { expect, test } from "bun:test";
import { domainNeedsSetup, domainsNeedingSetup, originChecking, originUnknownLong, setupReason } from "./needs-setup";

const base = {
  host: "shop.example.com",
  auto: false,
  forward: null,
  dnsStatus: "ok",
  origin: "node",
  certificate: { status: "valid" },
} as unknown as Parameters<typeof domainNeedsSetup>[0];
const d = (over: Record<string, unknown>) => ({ ...base, ...over }) as typeof base;

const now = Date.parse("2026-11-13T10:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

test("custom domains whose DNS, origin or certificate still need the owner count; the rest do not", () => {
  expect(domainNeedsSetup(base, now)).toBe(false);
  expect(setupReason(d({ dnsStatus: "missing" }), now)).toBe("dnsMissing");
  expect(setupReason(d({ dnsStatus: "wrongTarget" }), now)).toBe("dnsWrongTarget");
  expect(setupReason(d({ origin: "elsewhere" }), now)).toBe("originElsewhere");
  expect(setupReason(d({ dnsStatus: "proxied", origin: "elsewhere" }), now)).toBe("originElsewhere");
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: "node" }), now)).toBe(false);
  expect(setupReason(d({ certificate: { status: "failed" } }), now)).toBe("certificateFailed");
  // A certificate on its way is not the owner's job; automatic domains and forwards never count.
  expect(domainNeedsSetup(d({ certificate: { status: "pending" } }), now)).toBe(false);
  expect(domainNeedsSetup(d({ auto: true, dnsStatus: "missing" }), now)).toBe(false);
  expect(domainNeedsSetup(d({ forward: { url: "https://x.example" }, dnsStatus: "missing" }), now)).toBe(false);
});

// The owner's www (0.2.15): proxied, live with a valid certificate, and no origin stored. It counted, and nothing
// on the page said why. Not checked yet, or still being checked, is the panel's job, not the owner's.
test("behind Cloudflare: not checked yet or still being checked does not count; unknown for 30 minutes does", () => {
  const www = d({ host: "www.example.com", dnsStatus: "proxied", origin: undefined });
  expect(domainNeedsSetup(www, now)).toBe(false);
  expect(originChecking(www, now)).toBe(true);

  // Unknown for 29 minutes: still checking.
  const recent = d({ dnsStatus: "proxied", origin: "unknown", originUnknownSince: minutesAgo(29) });
  expect(domainNeedsSetup(recent, now)).toBe(false);
  expect(originChecking(recent, now)).toBe(true);
  // Unknown from before 0.2.16 (no run start yet): the panel checks it again first.
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: "unknown" }), now)).toBe(false);

  // Unknown for 30 minutes or more: the owner's, with Cloudflare's reason when it gave one.
  const long = d({ dnsStatus: "proxied", origin: "unknown", originUnknownSince: minutesAgo(30), originReason: "cloudflareCertificate" });
  expect(setupReason(long, now)).toBe("originUnknown");
  expect(originUnknownLong(long, now)).toBe(true);
  expect(originChecking(long, now)).toBe(false);
  // A failed certificate is named first.
  expect(setupReason({ ...long, certificate: { status: "failed" } } as typeof base, now)).toBe("certificateFailed");

  // With DNS straight at the node, the record itself proves it: an unknown origin never counts.
  const direct = d({ dnsStatus: "ok", origin: "unknown", originUnknownSince: minutesAgo(600) });
  expect(domainNeedsSetup(direct, now)).toBe(false);
  expect(originChecking(direct, now)).toBe(false);
  // Known answers are not "checking".
  expect(originChecking(d({ dnsStatus: "proxied", origin: "node" }), now)).toBe(false);
  expect(originChecking(d({ dnsStatus: "proxied", origin: "elsewhere" }), now)).toBe(false);
});

test("the badge's list: the domains it counts, by name, in order", () => {
  const list = [
    base,
    d({ host: "admin.example.com", dnsStatus: "missing" }),
    d({ host: "www.example.com", dnsStatus: "proxied", origin: undefined }),
    d({ host: "api.example.com", dnsStatus: "proxied", origin: "unknown", originUnknownSince: minutesAgo(45) }),
    d({ host: "old.example.com", origin: "elsewhere" }),
  ];
  expect(domainsNeedingSetup(list, now).map((x) => x.host)).toEqual(["admin.example.com", "api.example.com", "old.example.com"]);
  expect(domainsNeedingSetup(undefined, now)).toEqual([]);
});

test("a domain with no route counts when the domain is the problem, not while its service has not deployed", () => {
  // Behind Cloudflare without an origin check: the deploy is what is missing, not the record.
  expect(domainNeedsSetup(d({ dnsStatus: "proxied", origin: undefined, noRoute: { reason: "notDeployed" } }), now)).toBe(false);
  expect(setupReason(d({ noRoute: { reason: "stackParent" } }), now)).toBe("noRoute");
  expect(domainNeedsSetup(d({ noRoute: { reason: "cronService" } }), now)).toBe(true);
  expect(domainNeedsSetup(d({ noRoute: { reason: "routeWriteFailed", error: "x" } }), now)).toBe(true);
  // No route: nothing to check, so neither checking nor unknown for long.
  expect(originChecking(d({ dnsStatus: "proxied", origin: undefined, noRoute: { reason: "notDeployed" } }), now)).toBe(false);
});
