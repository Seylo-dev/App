import { expect, test } from "bun:test";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { WatchPathsCard, watchPathsDraft } from "./watch-paths";

// Only what WatchPathsCard reads.
const serviceWith = (watchPaths: string[]) => ({ id: "svc00000000000001", watchPaths }) as unknown as ServiceDetail;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const refusal = "apps/docs/.. never matches a file: paths start at the repository root. To watch a folder, write apps/docs/**";

test("typing a pattern that never matches shows the panel's message and keeps Save off", () => {
  const typed = watchPathsDraft("apps/web/**\napps/docs/..\n", []);
  expect(typed.refused).toEqual([{ pattern: "apps/docs/..", error: refusal }]);
  expect(typed.changed).toBe(true);
  expect(typed.canSave).toBe(false);

  const fixed = watchPathsDraft("apps/web/**\napps/docs/**\n", []);
  expect(fixed.refused).toEqual([]);
  expect(fixed.canSave).toBe(true);
  expect(fixed.patterns).toEqual(["apps/web/**", "apps/docs/**"]);

  const outside = watchPathsDraft("../shared/**", []);
  expect(outside.refused[0]?.error).toBe(
    "../shared/** never matches a file: paths start at the repository root. To watch a folder, write folder/**",
  );
});

test("ordinary patterns and a leading ./ are not refused; an unchanged list cannot be saved", () => {
  const ok = watchPathsDraft("./src/**\n**/*.md\n!docs/**\n.github/workflows/*.yml", []);
  expect(ok.refused).toEqual([]);
  expect(ok.patterns).toEqual(["src/**", "**/*.md", "!docs/**", ".github/workflows/*.yml"]);
  expect(ok.canSave).toBe(true);
  expect(watchPathsDraft("./src/**", ["src/**"]).canSave).toBe(false);
});

test("a stored pattern that never matches shows the message under the patterns, with Save off", async () => {
  const html = await renderStatic(() => <WatchPathsCard service={serviceWith(["apps/web/**", "apps/docs/.."])} />);
  const out = text(html);
  expect(out).toContain(refusal);
  expect(html).toMatch(/role="alert"[^>]*>apps\/docs\/\.\. never matches a file/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Save watch paths/);
});

test("usable stored patterns show no message", async () => {
  const out = text(await renderStatic(() => <WatchPathsCard service={serviceWith(["apps/web/**", "!**/*.md"])} />));
  expect(out).toContain("Save watch paths");
  expect(out).not.toContain("never matches a file");
});
