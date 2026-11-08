import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Select, SelectTrigger, SelectValue } from "@seylo/ui/components/select";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../i18n/t";
import { renderStatic } from "../test/render";
import { NodePicker, ProjectPicker } from "./pickers";
import { DomainsPanel } from "./service/overview/overview-page";
import type { ServiceDetail } from "./service/use-service";

const loading = t("common.loading");
const noop = () => {};

test("a loading select trigger shows a skeleton line and stays shut", () => {
  const out = renderToStaticMarkup(
    <Select>
      <SelectTrigger loading aria-label="Node">
        <SelectValue placeholder="No nodes yet" />
      </SelectTrigger>
    </Select>,
  );
  expect(out).toContain('data-slot="skeleton"');
  expect(out).toContain('aria-busy="true"');
  expect(out).toMatch(/<button[^>]*disabled=""/);
  expect(out).not.toContain("No nodes yet");
});

test("the node and project pickers show a skeleton, not 'Loading', until their list is in", async () => {
  for (const picker of [
    <NodePicker key="n" id="node" value="" onChange={noop} />,
    <ProjectPicker key="p" id="project" value="" onChange={noop} />,
  ]) {
    const out = await renderStatic(() => picker);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-slot="skeleton"');
    expect(out).not.toContain(`>${loading}<`);
  }
});

test("the overview's Domains panel shows placeholder rows while domains.list loads", async () => {
  const service = { id: "svc-1", projectId: "prj-1" } as ServiceDetail;
  const out = await renderStatic(() => <DomainsPanel service={service} />);
  expect(out).toContain('role="status"');
  expect(out).toContain('data-slot="skeleton"');
  expect(out).not.toContain(`>${loading}<`);
});

/** Every .tsx file under src, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

test("no select puts 'Loading' in its placeholder (SelectTrigger loading instead)", () => {
  const offenders = sources(join(import.meta.dir, "..")).filter((path) =>
    /<SelectValue[^>]*placeholder=\{[^}]*(common|service)\.loading/.test(readFileSync(path, "utf8")),
  );
  expect(offenders).toEqual([]);
});
