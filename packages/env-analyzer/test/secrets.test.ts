import { describe, expect, test } from "bun:test";
import { isSecretEntry, isSecretName, looksSecret, parseEnv, secretOverride } from "../src";

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
});
