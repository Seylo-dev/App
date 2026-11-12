import { describe, expect, test } from "bun:test";
import type { AnalyzeContext } from "../src";
import {
  classifyEntries,
  classifySecret,
  isSecretEntry,
  isSecretName,
  looksSecret,
  parseEnv,
  publicPrefixes,
  publicPrefixOf,
  secretOverride,
} from "../src";

describe("secret classification", () => {
  test("names, values and references", () => {
    for (const name of ["STRIPE_SECRET", "GITHUB_TOKEN", "DB_PASSWORD", "API_KEY", "PRIVATE_PEM", "AWS_CREDENTIALS", "SENTRY_DSN"])
      expect([name, isSecretName(name)]).toEqual([name, true]);
    for (const name of ["NODE_ENV", "PORT", "NEXT_PUBLIC_API_URL", "VITE_APP_TITLE", "DATABASE_URL"])
      expect([name, isSecretName(name)]).toEqual([name, false]);
    expect(looksSecret("postgres://app:hunter2@db:5432/app")).toBe(true);
    // A fake Stripe-style key, joined at runtime so secret scanners don't flag the fixture.
    expect(looksSecret(["sk", "live", "51Hx9Yb2eZvKYlo2C0aBcDeFgH"].join("_"))).toBe(true);
    expect(looksSecret("https://api.example.com/v1")).toBe(false);
    expect(looksSecret("production")).toBe(false);
    expect(looksSecret("postgres://db:5432/app")).toBe(false);

    const text = "NODE_ENV=production\nDATABASE_URL=${{db.INTERNAL_URL}}\nAPI=${{api.URL}}\n";
    const parsed = parseEnv(text);
    const credential = (ref: { target: string; variable: string }) => ref.target === "db";
    expect(parsed.entries.map((e) => [e.key, isSecretEntry(parsed, e, credential)])).toEqual([
      ["NODE_ENV", false],
      ["DATABASE_URL", true],
      ["API", false],
    ]);
  });

  test("a comment above or after the value overrides the guess", () => {
    const text =
      "# @public\nNEXT_PUBLIC_ANON_KEY=abc\nTITLE=Shop # @secret\nA=1 # @secret\nB=2\n  # @public  shown in the bundle\nAPI_TOKEN=x\n";
    const parsed = parseEnv(text);
    expect(parsed.entries.map((e) => [e.key, secretOverride(parsed, e), isSecretEntry(parsed, e)])).toEqual([
      ["NEXT_PUBLIC_ANON_KEY", "public", false],
      ["TITLE", "secret", true],
      ["A", "secret", true],
      // A's trailing comment is not B's.
      ["B", null, false],
      ["API_TOKEN", "public", false],
    ]);
  });

  // A Next.js app's Dockerfile checked ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY: the name has KEY in it and
  // the value is token-like, so it was a secret, reached the build only as a BuildKit secret file and
  // the ARG stayed empty. What a framework ships to every browser is public.
  test("a framework's public prefix makes a variable public whatever its name or value says", () => {
    // Fake keys, joined at runtime so secret scanners don't flag the fixture.
    const siteKey = ["0x4AAAAAAA", "Bc3dEf5gH7jK9mN1pQ"].join("");
    const text = [
      `NEXT_PUBLIC_TURNSTILE_SITE_KEY=${siteKey}`,
      "NEXT_PUBLIC_API_URL=https://api.example.com",
      `VITE_STRIPE_PUBLISHABLE_KEY=${["pk", "test", "51Hx9Yb2eZvKYlo2C0aBcDeFgH"].join("_")}`,
      "PUBLIC_SUPABASE_ANON_KEY=${{db.PASSWORD}}",
      `REACT_APP_MAPS_KEY=${["AIza", "SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStU"].join("")}`,
      "NUXT_PUBLIC_SENTRY_DSN=https://abc@o1.ingest.sentry.io/1",
      "EXPO_PUBLIC_API_KEY=k1",
      "GATSBY_ALGOLIA_SEARCH_KEY=k2",
      "VUE_APP_TOKEN=k3",
      "# @secret",
      "NEXT_PUBLIC_REALLY_SECRET=x",
      `TURNSTILE_SECRET_KEY=${siteKey}`,
      "next_public_lower_key=x",
      "PUBLIC_=x",
      "",
    ].join("\n");
    const parsed = parseEnv(text);
    const credential = (ref: { target: string }) => ref.target === "db";
    expect(parsed.entries.map((e) => [e.key, isSecretEntry(parsed, e, credential)])).toEqual([
      ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", false],
      ["NEXT_PUBLIC_API_URL", false],
      ["VITE_STRIPE_PUBLISHABLE_KEY", false],
      // A reference to a password does not change it: the framework ships its value either way.
      ["PUBLIC_SUPABASE_ANON_KEY", false],
      ["REACT_APP_MAPS_KEY", false],
      ["NUXT_PUBLIC_SENTRY_DSN", false],
      ["EXPO_PUBLIC_API_KEY", false],
      ["GATSBY_ALGOLIA_SEARCH_KEY", false],
      ["VUE_APP_TOKEN", false],
      // "# @secret" still makes one a secret.
      ["NEXT_PUBLIC_REALLY_SECRET", true],
      ["TURNSTILE_SECRET_KEY", true],
      // The frameworks match the prefix exactly, upper case, with a name after it.
      ["next_public_lower_key", true],
      ["PUBLIC_", false],
    ]);
    const entry = (key: string) => {
      const found = parsed.entries.find((e) => e.key === key);
      if (!found) throw new Error(`no entry ${key}`);
      return found;
    };
    expect(classifySecret(parsed, entry("NEXT_PUBLIC_TURNSTILE_SITE_KEY"))).toEqual({
      secret: false,
      reason: "publicPrefix",
      detail: "NEXT_PUBLIC_",
      overridesGuess: true,
    });
    expect(classifySecret(parsed, entry("NEXT_PUBLIC_API_URL")).overridesGuess).toBe(false);
    expect(classifySecret(parsed, entry("NEXT_PUBLIC_REALLY_SECRET"))).toEqual({ secret: true, reason: "comment" });
  });

  test("the prefix list, and isSecretName: public prefixes are not secret names, every other name is as before", () => {
    expect(publicPrefixes.map((p) => p.prefix)).toEqual([
      "NEXT_PUBLIC_",
      "NUXT_PUBLIC_",
      "EXPO_PUBLIC_",
      "REACT_APP_",
      "VUE_APP_",
      "GATSBY_",
      "VITE_",
      "PUBLIC_",
    ]);
    expect(publicPrefixOf("NEXT_PUBLIC_X")).toBe("NEXT_PUBLIC_");
    expect(publicPrefixOf("PUBLIC_X")).toBe("PUBLIC_");
    expect(publicPrefixOf("MY_PUBLIC_KEY")).toBeNull();
    expect(publicPrefixOf("VITE")).toBeNull();
    for (const name of ["NEXT_PUBLIC_TURNSTILE_SITE_KEY", "VITE_API_KEY", "PUBLIC_TOKEN", "GATSBY_SECRET"])
      expect([name, isSecretName(name)]).toEqual([name, false]);
    // Names that only contain a prefix's words, or use another case, still read as secret names.
    for (const name of ["MY_PUBLIC_KEY", "public_key_x", "NEXTPUBLIC_KEY", "APP_VITE_TOKEN", "STRIPE_SECRET_KEY"])
      expect([name, isSecretName(name)]).toEqual([name, true]);
  });

  test("why: comment, name, value, reference, resolved value, none", () => {
    const text =
      "# @public\nAPI_TOKEN=x\nDB_PASSWORD=x\nRANDOM=Zx81kLq0Pw2mNv7Bc4Rt9Ys6\nURL=${{db.PASSWORD}}\nFROM=${{api.BUILD_ID}}\nMODE=production\n";
    const parsed = parseEnv(text);
    const context: AnalyzeContext = {
      self: { serviceId: "s1", name: "web", nodes: [] },
      targets: [
        {
          name: "db",
          kind: "service",
          serviceId: "s2",
          serviceKind: "postgres",
          nodes: [],
          internalHost: "db",
          exposed: false,
          variables: [{ name: "PASSWORD", value: "pw", scope: "plain", sensitive: true, description: "" }],
        },
        {
          name: "api",
          kind: "service",
          serviceId: "s3",
          serviceKind: "app",
          nodes: [],
          internalHost: "api",
          exposed: false,
          // Own variables are sensitive for the editor's masking; secret is the panel's decision.
          variables: [{ name: "BUILD_ID", value: "Zx81kLq0Pw2mNv7Bc4Rt9Ys6", scope: "plain", sensitive: true, secret: false, description: "" }],
        },
      ],
    };
    expect(classifyEntries(parsed, context)).toEqual([
      { secret: false, reason: "comment", overridesGuess: true },
      { secret: true, reason: "name" },
      { secret: true, reason: "value" },
      { secret: true, reason: "reference", detail: "db.PASSWORD" },
      // Not a secret by its flag, but it resolves to a token.
      { secret: true, reason: "value" },
      { secret: false, reason: "none" },
    ]);
    // Without the panel's flag, sensitive decides.
    const api = context.targets[1]?.variables[0];
    if (!api) throw new Error("no variable");
    delete api.secret;
    expect(classifyEntries(parsed, context)[4]).toEqual({ secret: true, reason: "reference", detail: "api.BUILD_ID" });
  });
});
