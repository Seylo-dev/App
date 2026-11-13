// The zone a domain's record belongs in stops at its registrable domain
// (Public Suffix List, ICANN section). Before, a host under a domain that
// does not exist (app-preview.<typo>.co.il) walked on to the first
// name with NS records, the public suffix: "Add this record where co.il's
// DNS is managed: A app-preview.<typo> <node ip>". Now the check
// says the registrable domain does not exist (zoneMissing), names the
// record relative to it, suggests a domain the caller can see that is a
// likely spelling, and domains.add and addAuto add the domain with a
// warning instead.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { domains as domainOps } from "@seylo/ops";
import { editDistance, suggestRegistrable } from "../src/modules/domains/did-you-mean";
import { checkHost, type DnsLookups, publicDns, relativeName, setDnsLookups } from "../src/modules/domains/dns";
import { registrableWarning, setWarningWait, warningWaitMs } from "../src/modules/domains/missing-registrable";
import { findZone, isPrivateName, nsCacheMs, registrableDomain } from "../src/modules/domains/zone";
import { setSetting } from "../src/settings";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

/** A resolver with NS records per name and A records per host; it records every NS question, and `fail` makes one throw that code. */
function resolver(ns: Record<string, string[]>, a: Record<string, string[]> = {}, fail: Record<string, string> = {}) {
  const asked: string[] = [];
  const dns: DnsLookups = {
    resolve4: async (name) => a[name] ?? [],
    resolve6: async () => [],
    resolveCname: async () => [],
    resolveNs: async (name) => {
      asked.push(name);
      const code = fail[name];
      if (code) throw Object.assign(new Error(`queryNs ${code} ${name}`), { code });
      return ns[name] ?? [];
    },
  };
  return { dns, asked };
}

// Public suffixes answer NS like the real ones do: a walk that reaches them finds a "zone" there.
const registry = ["ns1.registry.example"];
const suffixes: Record<string, string[]> = {
  il: registry,
  "co.il": registry,
  uk: registry,
  "co.uk": registry,
  au: registry,
  "com.au": registry,
  com: registry,
  "xn--p1ai": registry,
  "xn--4dbrk0ce": registry,
  "xn--4dbgdty6c.xn--4dbrk0ce": registry,
};
const isSuffix = (name: string) => name in suffixes;

const node = { ipv4: "203.0.113.10", ipv6: null };

describe("the registrable domain", () => {
  test("from the ICANN section of the Public Suffix List, never a public suffix itself", () => {
    expect(registrableDomain("app-preview.exampel.co.il")).toEqual({ domain: "exampel.co.il", suffix: "co.il" });
    expect(registrableDomain("a.b.example.co.uk")).toEqual({ domain: "example.co.uk", suffix: "co.uk" });
    expect(registrableDomain("shop.example.com.au")).toEqual({ domain: "example.com.au", suffix: "com.au" });
    expect(registrableDomain("www.example.com")).toEqual({ domain: "example.com", suffix: "com" });
    expect(registrableDomain("*.apps.example.co.il")).toEqual({ domain: "example.co.il", suffix: "co.il" });
    // IDN hosts arrive in punycode: пример.рф, and example under the second-level suffix אקדמיה.ישראל.
    expect(registrableDomain("www.xn--e1afmkfd.xn--p1ai")).toEqual({ domain: "xn--e1afmkfd.xn--p1ai", suffix: "xn--p1ai" });
    expect(registrableDomain("www.example.xn--4dbgdty6c.xn--4dbrk0ce")).toEqual({
      domain: "example.xn--4dbgdty6c.xn--4dbrk0ce",
      suffix: "xn--4dbgdty6c.xn--4dbrk0ce",
    });
    for (const suffix of ["co.il", "co.uk", "com.au", "com", "xn--p1ai"]) expect(registrableDomain(suffix)).toBeNull();
  });
});

describe("findZone", () => {
  test("a registrable domain with no name servers is missing under co.il, co.uk, com.au and .com: the walk never reaches the suffix", async () => {
    for (const [host, registrable] of [
      ["app-preview.exampel.co.il", "exampel.co.il"],
      ["shop.exampel.co.uk", "exampel.co.uk"],
      ["www.exampel.com.au", "exampel.com.au"],
      ["app.exampel.com", "exampel.com"],
    ] as const) {
      const { dns, asked } = resolver(suffixes);
      expect(await findZone(host, dns)).toEqual({ zone: null, cloudflare: false, registrable, registrableMissing: true });
      expect(asked.filter(isSuffix)).toEqual([]);
      expect(asked.sort()).toEqual([host, registrable].sort());
    }
  });

  test("the registrable domain, a delegated sub-zone, the apex and a wildcard host", async () => {
    const { dns, asked } = resolver({
      ...suffixes,
      "example.co.il": ["ns1.registrar.example"],
      "sub.example.co.il": ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    expect(await findZone("shop.example.co.il", dns)).toEqual({
      zone: "example.co.il",
      cloudflare: false,
      registrable: "example.co.il",
      registrableMissing: false,
    });
    // A deeper zone with its own NS records is found before the registrable domain.
    expect(await findZone("app.sub.example.co.il", dns)).toEqual({
      zone: "sub.example.co.il",
      cloudflare: true,
      registrable: "example.co.il",
      registrableMissing: false,
    });
    expect(relativeName("app.sub.example.co.il", "sub.example.co.il")).toBe("app");
    const apex = await findZone("example.co.il", dns);
    expect(apex.zone).toBe("example.co.il");
    expect(relativeName("example.co.il", "example.co.il")).toBe("@");
    // A wildcard host: the records are asked for under its "*.", and the name keeps it.
    const wildcard = await findZone("*.apps.example.co.il", dns);
    expect(wildcard.zone).toBe("example.co.il");
    expect(relativeName("*.apps.example.co.il", "example.co.il")).toBe("*.apps");
    expect(asked.some((name) => name.startsWith("*"))).toBe(false);
    expect(asked.filter(isSuffix)).toEqual([]);
  });

  test("punycode IDN hosts stop at their registrable domain too", async () => {
    const missing = resolver(suffixes);
    expect(await findZone("www.xn--e1afmkfd.xn--p1ai", missing.dns)).toMatchObject({
      zone: null,
      registrable: "xn--e1afmkfd.xn--p1ai",
      registrableMissing: true,
    });
    // Under a second-level IDN suffix the walk does not stop one label early.
    expect(await findZone("www.example.xn--4dbgdty6c.xn--4dbrk0ce", missing.dns)).toMatchObject({
      zone: null,
      registrable: "example.xn--4dbgdty6c.xn--4dbrk0ce",
      registrableMissing: true,
    });
    expect(missing.asked.filter(isSuffix)).toEqual([]);
    const found = resolver({ ...suffixes, "xn--e1afmkfd.xn--p1ai": ["ns1.registrar.example"] });
    expect((await findZone("www.xn--e1afmkfd.xn--p1ai", found.dns)).zone).toBe("xn--e1afmkfd.xn--p1ai");
  });

  test("a public suffix as the host has no zone and asks nothing", async () => {
    const { dns, asked } = resolver(suffixes);
    expect(await findZone("co.il", dns)).toEqual({ zone: null, cloudflare: false, registrable: null, registrableMissing: false });
    expect(asked).toEqual([]);
  });

  test("publicDns throws a SERVFAIL for NS lookups only; NXDOMAIN and no records stay empty answers", async () => {
    const reject = (code: string) => async () => {
      throw Object.assign(new Error(code), { code });
    };
    const dns = publicDns({
      resolve4: reject("ESERVFAIL"),
      resolve6: reject("ENODATA"),
      resolveCname: reject("ENOTFOUND"),
      resolveNs: reject("ESERVFAIL"),
    } as never);
    expect(await dns.resolve4("shop.example.co.il")).toEqual([]);
    expect(await dns.resolve6("shop.example.co.il")).toEqual([]);
    expect(await dns.resolveCname("shop.example.co.il")).toEqual([]);
    await expect(dns.resolveNs("example.co.il")).rejects.toMatchObject({ code: "ESERVFAIL" });
    const missing = publicDns({ resolveNs: reject("ENOTFOUND") } as never);
    expect(await missing.resolveNs("exampel.co.il")).toEqual([]);
    const timeout = publicDns({ resolveNs: reject("ETIMEOUT") } as never);
    await expect(timeout.resolveNs("example.co.il")).rejects.toMatchObject({ code: "ETIMEOUT" });
  });

  test("a server failure at the registrable domain is not a missing domain; a timeout fails the check as before", async () => {
    // A lame delegation (registered, its name servers do not answer) is SERVFAIL, which publicDns throws for NS lookups.
    const lame = resolver(suffixes, {}, { "exampel.co.il": "ESERVFAIL" });
    expect(await findZone("shop.exampel.co.il", lame.dns)).toEqual({
      zone: null,
      cloudflare: false,
      registrable: "exampel.co.il",
      registrableMissing: false,
    });
    const slow = resolver(suffixes, {}, { "exampel.co.il": "ETIMEOUT" });
    const checked = await checkHost("shop.exampel.co.il", [node], slow.dns);
    expect(checked).toMatchObject({ status: "unknown", zone: null, zoneMissing: false, registrable: "exampel.co.il" });
    expect(checked.message).toContain("The DNS lookup for shop.exampel.co.il failed");
  });

  test("NS answers are kept for a minute; a lookup that throws is asked again", async () => {
    try {
      const start = new Date("2026-11-13T10:00:00Z");
      setSystemTime(start);
      const { dns, asked } = resolver({ ...suffixes, "example.co.il": ["ns1.registrar.example"] });
      await checkHost("shop.example.co.il", [node], dns);
      await checkHost("shop.example.co.il", [node], dns);
      expect(asked.sort()).toEqual(["example.co.il", "shop.example.co.il"]);
      setSystemTime(new Date(start.getTime() + nsCacheMs));
      await checkHost("shop.example.co.il", [node], dns);
      expect(asked).toHaveLength(4);

      let fails = true;
      const flaky: DnsLookups = {
        ...dns,
        resolveNs: async (name) => {
          asked.push(name);
          if (fails) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
          return name === "example.co.il" ? ["ns1.registrar.example"] : [];
        },
      };
      expect((await checkHost("www.example.co.il", [node], flaky)).status).toBe("unknown");
      fails = false;
      expect((await checkHost("www.example.co.il", [node], flaky)).zone).toBe("example.co.il");
    } finally {
      setSystemTime();
    }
  });
});

describe("private names", () => {
  const privateHosts = [
    "app.apps.lab.internal",
    "app.something.localhost",
    "app.apps.home.arpa",
    "app.n1.example.test",
    "app.office.lan",
    "app.nas.local",
    "app.site.corp",
    // RFC 6761 reserves example.com, .net and .org as well.
    "app.n1.example.com",
  ];

  test("special-use names and private networks' top-level names; real domains are not", () => {
    for (const host of privateHosts) expect(isPrivateName(host)).toBe(true);
    for (const host of [
      "app.exampel.com",
      "www.example.co.il",
      "shop.example.co.uk",
      "latest.exampel.com",
      "x.myexample.com",
      "a.internals.co.il",
    ]) {
      expect(isPrivateName(host)).toBe(false);
    }
  });

  test("public resolvers know nothing of a private name, which does not make it missing", async () => {
    for (const host of privateHosts) {
      const { dns } = resolver(suffixes);
      const zone = await findZone(host, dns);
      expect(zone.registrableMissing).toBe(false);
      expect(zone.zone).toBeNull();
      const checked = await checkHost(host, [node], dns);
      expect(checked).toMatchObject({ status: "missing", zoneMissing: false });
      expect(checked.message).toBe(`No A record for ${host} yet. Create one pointing at 203.0.113.10.`);
    }
  });
});

describe("checkHost", () => {
  test("a missing registrable domain: zoneMissing, no zone, and the record relative to the registrable domain", async () => {
    const { dns } = resolver(suffixes);
    const checked = await checkHost("app-preview.exampel.co.il", [node], dns);
    expect(checked).toMatchObject({
      status: "missing",
      zone: null,
      registrable: "exampel.co.il",
      zoneMissing: true,
      cloudflareManaged: false,
      cloudflareDnsUrl: null,
      expected: [{ type: "A", name: "app-preview", value: "203.0.113.10" }],
    });
    expect(checked.message).toBe("exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling.");
  });

  test("a domain that answers is not missing, whatever its NS lookups said", async () => {
    const { dns } = resolver(suffixes, { "www.example.co.il": ["203.0.113.10"] });
    expect(await checkHost("www.example.co.il", [node], dns)).toMatchObject({ status: "ok", zoneMissing: false, zone: null });
  });

  test("a domain that exists keeps its zone and its usual message", async () => {
    const { dns } = resolver({ ...suffixes, "example.co.il": ["ns1.registrar.example"] });
    const checked = await checkHost("shop.example.co.il", [node], dns);
    expect(checked).toMatchObject({ status: "missing", zone: "example.co.il", registrable: "example.co.il", zoneMissing: false });
    expect(checked.expected[0]?.name).toBe("shop");
    expect(checked.message).toContain("No A record for shop.example.co.il yet");
  });
});

describe("edit distance", () => {
  test("adjacent letters swapped are one edit; anything past the limit stops early", () => {
    expect(editDistance("exmaple", "example", 2)).toBe(1);
    expect(editDistance("exampel", "example", 2)).toBe(1);
    expect(editDistance("exampl", "example", 2)).toBe(1);
    expect(editDistance("exumpel", "example", 2)).toBe(2);
    expect(editDistance("example", "example", 2)).toBe(0);
    expect(editDistance("abcdefg", "example", 2)).toBe(3);
    expect(editDistance("ex", "example", 2)).toBe(3);
  });
});

describe("domains ops", () => {
  let panel: TestPanel;
  let cookie: string;
  beforeEach(async () => {
    panel = testPanel();
    cookie = (await createUser(panel, "owner")).cookie;
  });
  afterEach(() => {
    setDnsLookups(null);
    setWarningWait(null);
    panel.close();
  });

  /** web (the caller's service) and shop in another project, which already has www.example.co.il and www.example.com. */
  async function setup() {
    const n = seedNode(panel, { ipv4: "203.0.113.10", wildcard: "n1.example.com" });
    const web = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [n.id], deployed: true });
    const shop = seedService(panel, { projectId: seedProject(panel).id, name: "shop", nodeIds: [n.id], deployed: true });
    setDnsLookups(resolver({ ...suffixes, "example.co.il": ["ns1.registrar.example"], "example.com": ["ns1.registrar.example"] }).dns);
    for (const host of ["www.example.co.il", "www.example.com"]) {
      expect((await callOp(panel, domainOps.add, { serviceId: shop.id, host }, { cookie })).status).toBe(200);
    }
    return { node: n, web, shop };
  }

  test("domains.add keeps a domain whose registrable domain does not exist, with a warning and Did you mean", async () => {
    const { web } = await setup();
    const added = await callOp(panel, domainOps.add, { serviceId: web.id, host: "app-preview.exampel.co.il" }, { cookie });
    expect(added.status).toBe(200);
    expect(added.body.dns).toMatchObject({
      zone: null,
      registrable: "exampel.co.il",
      zoneMissing: true,
      didYouMean: "example.co.il",
      expected: [{ type: "A", name: "app-preview", value: "203.0.113.10" }],
    });
    expect(added.body.domain.warning).toEqual({
      reason: "registrableMissing",
      registrable: "exampel.co.il",
      didYouMean: "example.co.il",
      message:
        "exampel.co.il does not exist: it is not registered, or has no name servers yet. Check the spelling. Did you mean example.co.il?",
    });
    // Not a refusal: the domain is there.
    const listed = await callOp(panel, domainOps.list, { serviceId: web.id }, { cookie });
    expect(listed.body.domains.map((d: { host: string }) => d.host)).toEqual(["app-preview.exampel.co.il"]);
    // A domain that exists has no warning.
    const fine = await callOp(panel, domainOps.add, { serviceId: web.id, host: "api.example.co.il" }, { cookie });
    expect(fine.body.domain.warning).toBeUndefined();
    expect(fine.body.dns).toMatchObject({ zone: "example.co.il", zoneMissing: false });
    expect(fine.body.dns.didYouMean).toBeUndefined();
  });

  test("domains.checkDns says the registrable domain is missing; Did you mean only from the same suffix", async () => {
    const { web } = await setup();
    const added = await callOp(panel, domainOps.add, { serviceId: web.id, host: "shop.exampel.co.il" }, { cookie });
    const checked = await callOp(panel, domainOps.checkDns, { serviceId: web.id, domainId: added.body.domain.id }, { cookie });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ zone: null, registrable: "exampel.co.il", zoneMissing: true, didYouMean: "example.co.il" });
    expect(checked.body.message).toEndWith("Check the spelling. Did you mean example.co.il?");
    // exampel.co.uk is no typo of example.co.il or example.com.
    const other = await callOp(panel, domainOps.add, { serviceId: web.id, host: "shop.exampel.co.uk" }, { cookie });
    expect(other.body.dns).toMatchObject({ zoneMissing: true, registrable: "exampel.co.uk" });
    expect(other.body.dns.didYouMean).toBeUndefined();
    expect(other.body.domain.warning).toEqual({
      reason: "registrableMissing",
      registrable: "exampel.co.uk",
      message: "exampel.co.uk does not exist: it is not registered, or has no name servers yet. Check the spelling.",
    });
  });

  test("Did you mean never names a domain the caller cannot see", async () => {
    const { web, shop } = await setup();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", web.id, ["domains.view", "domains.edit"]);
    const added = await callOp(panel, domainOps.add, { serviceId: web.id, host: "shop.exampel.co.il" }, { cookie: member.cookie });
    expect(added.status).toBe(200);
    // www.example.co.il is on shop, which the member may not view.
    expect(added.body.dns.zoneMissing).toBe(true);
    expect(added.body.dns.didYouMean).toBeUndefined();
    expect(added.body.dns.message).not.toContain("example.co.il?");
    expect(added.body.domain.warning.didYouMean).toBeUndefined();
    const ref = { serviceId: web.id, domainId: added.body.domain.id };
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie: member.cookie })).body.didYouMean).toBeUndefined();
    // Once they may view shop's domains, it is a fair suggestion.
    grant(panel, member.user.id, "service", shop.id, ["domains.view"]);
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie: member.cookie })).body.didYouMean).toBe("example.co.il");
  });

  test("the panel's own domain is a suggestion only for callers with settings.view", async () => {
    const { web } = await setup();
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", web.id, ["domains.view", "domains.edit"]);
    setSetting(panel.deps.db, "panelDomain", "panel.example.co.uk");
    const added = await callOp(panel, domainOps.add, { serviceId: web.id, host: "app.exampel.co.uk" }, { cookie });
    const ref = { serviceId: web.id, domainId: added.body.domain.id };
    expect(added.body.dns.didYouMean).toBe("example.co.uk");
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie })).body.didYouMean).toBe("example.co.uk");
    expect((await callOp(panel, domainOps.checkDns, ref, { cookie: member.cookie })).body.didYouMean).toBeUndefined();
    // The same through the helper, with a caller that sees nothing at all.
    expect(suggestRegistrable({ db: panel.deps.db, access: { can: () => false } }, "exampel.co.uk")).toBeNull();
    expect(suggestRegistrable({ db: panel.deps.db, access: { can: () => true } }, "exampel.co.uk")).toBe("example.co.uk");
  });

  test("a short name allows one edit, a longer one two; the closest wins", async () => {
    const { web } = await setup();
    const sees = { db: panel.deps.db, access: { can: () => true } };
    for (const host of ["www.acme.com", "www.exampled.com"]) {
      expect((await callOp(panel, domainOps.add, { serviceId: web.id, host }, { cookie })).status).toBe(200);
    }
    // acme: 4 letters, 1 edit at most.
    expect(suggestRegistrable(sees, "acne.com")).toBe("acme.com");
    expect(suggestRegistrable(sees, "acnu.com")).toBeNull();
    // example.com (1 edit) beats exampled.com (2 edits).
    expect(suggestRegistrable(sees, "exampe.com")).toBe("example.com");
    expect(suggestRegistrable(sees, "exumpel.com")).toBe("example.com");
    expect(suggestRegistrable(sees, "xxample.org")).toBeNull();
  });

  test("domains.addAuto warns when the node's wildcard domain does not exist; a failed lookup adds it without one", async () => {
    await setup();
    // The wildcard was typed with a typo on the node.
    const typo = seedNode(panel, { ipv4: "203.0.113.20", wildcard: "n2.exampel.com" });
    const app = seedService(panel, { projectId: seedProject(panel).id, name: "app", nodeIds: [typo.id], deployed: true });
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: app.id }, { cookie });
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ host: "app.n2.exampel.com", auto: true });
    expect(auto.body.warning).toEqual({
      reason: "registrableMissing",
      registrable: "exampel.com",
      didYouMean: "example.com",
      message:
        "exampel.com does not exist: it is not registered, or has no name servers yet. Check the spelling. Did you mean example.com?",
    });
    // A wildcard that exists: no warning (example.co.il has name servers; example.com is special-use, see "private names").
    const fine = onWildcard("fine", "n3.example.co.il");
    const ok = await callOp(panel, domainOps.addAuto, { serviceId: fine.id }, { cookie });
    expect(ok.status).toBe(200);
    expect(ok.body.warning).toBeUndefined();
    // The resolvers time out: no warning, and the domain is added all the same.
    setDnsLookups(resolver(suffixes, {}, { "example.co.il": "ETIMEOUT" }).dns);
    const slow = await callOp(panel, domainOps.addAuto, { serviceId: fine.id, subdomain: "fine2" }, { cookie });
    expect(slow.status).toBe(200);
    expect(slow.body.warning).toBeUndefined();
  });

  /** A service named `name` on a new node whose wildcard domain is `wildcard`. */
  function onWildcard(name: string, wildcard: string, ipv4 = "203.0.113.40") {
    const n = seedNode(panel, { ipv4, wildcard });
    return seedService(panel, { projectId: seedProject(panel).id, name, nodeIds: [n.id], deployed: true });
  }

  test("domains.addAuto answers within the wait when the resolvers do not, and the next one does not wait again", async () => {
    setWarningWait(300);
    const asked: string[] = [];
    // A panel that cannot reach 1.1.1.1 or 8.8.8.8: the NS lookups do not come back within the wait.
    setDnsLookups({
      resolve4: async () => [],
      resolve6: async () => [],
      resolveCname: async () => [],
      resolveNs: (name) => {
        asked.push(name);
        return new Promise<string[]>(() => {});
      },
    });
    const app = onWildcard("app", "n4.exampel.co.il");
    const started = Date.now();
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: app.id }, { cookie });
    expect(auto.status).toBe(200);
    expect(auto.body.warning).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(asked.sort()).toEqual(["app.n4.exampel.co.il", "exampel.co.il", "n4.exampel.co.il"]);
    // The same registrable domain within a minute: answered at once, nothing asked.
    const again = Date.now();
    const second = await callOp(panel, domainOps.addAuto, { serviceId: app.id, subdomain: "app2" }, { cookie });
    expect(second.status).toBe(200);
    expect(second.body.warning).toBeUndefined();
    expect(Date.now() - again).toBeLessThan(150);
    expect(asked).toHaveLength(3);
    // The wait the panel uses: a couple of seconds, not the resolvers' 20.
    expect(warningWaitMs).toBeLessThanOrEqual(3000);
  });

  test("a lookup that fails is not asked again for a minute; a late answer is used once it comes", async () => {
    const failing = resolver(suffixes, {}, { "exampel.co.il": "ETIMEOUT" });
    setDnsLookups(failing.dns);
    const app = onWildcard("app", "n5.exampel.co.il");
    expect((await callOp(panel, domainOps.addAuto, { serviceId: app.id }, { cookie })).body.warning).toBeUndefined();
    const asked = failing.asked.length;
    expect((await callOp(panel, domainOps.addAuto, { serviceId: app.id, subdomain: "app2" }, { cookie })).body.warning).toBeUndefined();
    expect(failing.asked).toHaveLength(asked);

    // Answers that come after the wait: the next addAuto reads them from the NS cache and warns.
    setWarningWait(100);
    const held: (() => void)[] = [];
    let hold = true;
    setDnsLookups({
      ...resolver(suffixes).dns,
      resolveNs: () => (hold ? new Promise<string[]>((resolve) => held.push(() => resolve([]))) : Promise.resolve([])),
    });
    const web = onWildcard("web", "n6.exampel.co.uk", "203.0.113.50");
    expect((await callOp(panel, domainOps.addAuto, { serviceId: web.id }, { cookie })).body.warning).toBeUndefined();
    hold = false;
    for (const answer of held) answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = await callOp(panel, domainOps.addAuto, { serviceId: web.id, subdomain: "web2" }, { cookie });
    expect(later.body.warning).toMatchObject({ reason: "registrableMissing", registrable: "exampel.co.uk" });
  });

  test("domains.addAuto asks nothing about a private wildcard domain and never calls it missing", async () => {
    const { dns, asked } = resolver(suffixes);
    setDnsLookups(dns);
    for (const [i, wildcard] of ["apps.lab.internal", "something.localhost", "apps.home.arpa", "n1.example.test", "office.lan"].entries()) {
      const service = onWildcard(`app${i}`, wildcard, `203.0.113.${60 + i}`);
      const auto = await callOp(panel, domainOps.addAuto, { serviceId: service.id }, { cookie });
      expect(auto.status).toBe(200);
      expect(auto.body.warning).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  test("domains.addAuto: a host that answers exists, whatever its NS lookups said", async () => {
    // No delegation of its own: the records are served from the suffix's zone (as www.gov.il is).
    const { dns } = resolver(suffixes, { "app.apps.example.gov.il": ["203.0.113.70"] });
    setDnsLookups(dns);
    const app = onWildcard("app", "apps.example.gov.il", "203.0.113.70");
    const auto = await callOp(panel, domainOps.addAuto, { serviceId: app.id }, { cookie });
    expect(auto.status).toBe(200);
    expect(auto.body.warning).toBeUndefined();
    // Nothing answers for another name there: the warning stands.
    const sees = { db: panel.deps.db, access: { can: () => true } };
    expect(await registrableWarning(sees, "web.apps.example.gov.il", dns)).toMatchObject({
      reason: "registrableMissing",
      registrable: "example.gov.il",
    });
  });
});
