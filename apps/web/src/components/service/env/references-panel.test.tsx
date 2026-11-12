// The References panel lists the service being edited first, with its own
// built-ins (URL, DOMAIN, the internal address) and none of its own .env
// variables, then the other services; a panel that sends no self.builtins
// gets no group for it.

import { expect, test } from "bun:test";
import { type AnalyzeContext, appVariables, databaseVariables, type ReferenceVariable } from "@seylo/env-analyzer";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import { ReferencesPanel, shownValue } from "./references-panel";

const node = { id: "node00000000000a", name: "de-fsn-1" };
const web = { URL: "", DOMAIN: "", INTERNAL_URL: "http://web:3000", INTERNAL_HOST: "web", INTERNAL_PORT: "3000" };
const builtins = (values: Record<string, string>, defs = appVariables): ReferenceVariable[] =>
  defs.map((d) => ({ ...d, value: values[d.name] ?? "" }));

const api = {
  name: "api",
  kind: "service" as const,
  serviceId: "svc0000000000api",
  serviceKind: "app",
  nodes: [node],
  internalHost: "api",
  exposed: true,
  variables: [
    ...builtins({ URL: "https://api.example.com", DOMAIN: "api.example.com", INTERNAL_URL: "http://api:3000" }),
    {
      name: "PUBLIC_NAME",
      value: "shop",
      scope: "plain" as const,
      sensitive: true,
      description: "variable of this service",
      dependsOn: [],
    },
  ],
};

const context = (self: Partial<AnalyzeContext["self"]> = {}, targets = [api]): AnalyzeContext => ({
  self: { serviceId: "svc0000000000web", name: "web", nodes: [node], builtins: builtins(web), ...self },
  targets,
});

const render = (ctx: AnalyzeContext, kind = "app") =>
  renderStatic(() => (
    <TooltipProvider>
      <ReferencesPanel context={ctx} serviceKind={kind} projectId="prj0000000000001" reveal={false} onInsert={() => {}} />
    </TooltipProvider>
  ));

/** The chip names in the markup, in order. */
const chips = (html: string) => [...html.matchAll(/<button type="button"[^>]*>([A-Z_]+)<\/button>/g)].map((m) => m[1]);

test("the service itself comes first, with its built-ins and none of its own variables", async () => {
  const out = await render(context());
  const self = out.indexOf(`>${t("serviceEnv.refs.thisService")}<`);
  const name = out.indexOf('<b class="font-semibold">web</b>');
  expect(name).toBeGreaterThan(-1);
  expect(name).toBeLessThan(self);
  expect(out.indexOf('<b class="font-semibold">api</b>')).toBeGreaterThan(self);
  // Its APP badge, then the same chips as any other group.
  expect(out.slice(0, self)).toContain(">APP<");
  expect(chips(out.slice(0, out.indexOf('<b class="font-semibold">api</b>')))).toEqual([
    "URL",
    "DOMAIN",
    "INTERNAL_URL",
    "INTERNAL_HOST",
    "INTERNAL_PORT",
  ]);
  // api keeps its own variable; the edited service never lists one (the lines of its file).
  expect(chips(out)).toEqual([
    "URL",
    "DOMAIN",
    "INTERNAL_URL",
    "INTERNAL_HOST",
    "INTERNAL_PORT",
    "URL",
    "DOMAIN",
    "INTERNAL_URL",
    "INTERNAL_HOST",
    "INTERNAL_PORT",
    "PUBLIC_NAME",
  ]);
  // Its internal address works from where it runs: nothing is struck through.
  expect(out).not.toContain('aria-disabled="true"');
});

test("a database lists its own database set under its engine's badge", async () => {
  const values = {
    INTERNAL_URL: "postgres://postgres:pw@db:5432/shop",
    INTERNAL_HOST: "db",
    INTERNAL_PORT: "5432",
    USER: "postgres",
    PASSWORD: "pw",
    DATABASE: "shop",
  };
  const out = await render(context({ name: "db", builtins: builtins(values, databaseVariables) }, []), "postgres");
  expect(out).toContain(">PG<");
  expect(chips(out)).toEqual(databaseVariables.map((v) => v.name));
  // Nothing else in the project yet: the hint says what shows up, not "nothing to reference".
  expect(out).toContain(t("serviceEnv.refs.emptyOthers"));
  expect(out).not.toContain(t("serviceEnv.refs.empty"));
});

test("no group for the service itself without its built-ins (an older panel)", async () => {
  for (const ctx of [context({ builtins: [] }), context({ builtins: undefined })]) {
    const out = await render(ctx);
    expect(out).not.toContain(t("serviceEnv.refs.thisService"));
    expect(chips(out)[0]).toBe("URL");
    expect(chips(out)).toHaveLength(api.variables.length);
  }
  const empty = await render(context({ builtins: undefined }, []));
  expect(empty).toContain(t("serviceEnv.refs.empty"));
});

test("the tip's value line: the value, or why there is none", () => {
  const domain = { name: "DOMAIN", value: "", scope: "public" as const, sensitive: false, description: "" };
  expect(shownValue(domain, false)).toBe(t("serviceEnv.hover.empty"));
  expect(shownValue({ ...domain, value: null }, false)).toBe(t("serviceEnv.hover.unknown"));
  expect(shownValue({ ...domain, value: "web.example.com" }, false)).toBe("web.example.com");
  const password = { ...domain, name: "PASSWORD", value: "pw", sensitive: true };
  expect(shownValue(password, false)).toBe(t("serviceEnv.hover.hidden"));
  expect(shownValue(password, true)).toBe("pw");
});
