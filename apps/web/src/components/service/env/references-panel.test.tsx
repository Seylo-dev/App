// The References panel lists the service being edited first, with its own
// built-ins (URL, DOMAIN, the internal address) and none of its own .env
// variables, then the other services; a panel that sends no self.builtins
// gets no group for it. A variable that is empty right now gets no chip and
// a group left with none is not shown; a value the caller may not see
// (null) is not empty and keeps its chip. A service built from a
// repository is told that each deploy also sets GIT_SHA.

import { expect, test } from "bun:test";
import { type AnalyzeContext, appVariables, databaseVariables, type ReferenceTarget, type ReferenceVariable } from "@seylo/env-analyzer";
import { TooltipProvider } from "@seylo/ui/components/tooltip";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import { buildsFromRepository, hasValue, ReferencesPanel, shownValue } from "./references-panel";

const node = { id: "node00000000000a", name: "de-fsn-1" };
const other = { id: "node00000000000b", name: "us-ash-1" };
// No domain yet: URL and DOMAIN are empty.
const web = { URL: "", DOMAIN: "", INTERNAL_URL: "http://web:3000", INTERNAL_HOST: "web", INTERNAL_PORT: "3000" };
const builtins = (values: Record<string, string | null>, defs = appVariables): ReferenceVariable[] =>
  defs.map((d) => ({ ...d, value: d.name in values ? (values[d.name] ?? null) : "" }));

const api = {
  name: "api",
  kind: "service" as const,
  serviceId: "svc0000000000api",
  serviceKind: "app",
  nodes: [node],
  internalHost: "api",
  exposed: true,
  variables: [
    ...builtins({
      URL: "https://api.example.com",
      DOMAIN: "api.example.com",
      INTERNAL_URL: "http://api:3000",
      INTERNAL_HOST: "api",
      INTERNAL_PORT: "3000",
    }),
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

const service = (name: string, variables: ReferenceVariable[], more: Partial<ReferenceTarget> = {}): ReferenceTarget => ({
  name,
  kind: "service",
  serviceId: `svc00000000${name.padEnd(5, "0").slice(0, 5)}`,
  serviceKind: "app",
  nodes: [node],
  internalHost: name,
  exposed: false,
  variables,
  ...more,
});

const shared = (variables: Record<string, string | null>): ReferenceTarget => ({
  name: "project",
  kind: "shared",
  serviceId: null,
  serviceKind: null,
  nodes: [],
  internalHost: null,
  exposed: false,
  variables: Object.entries(variables).map(([name, value]) => ({
    name,
    value,
    scope: "plain",
    sensitive: true,
    secret: name.endsWith("_PASS"),
    description: "shared variable",
  })),
});

const context = (self: Partial<AnalyzeContext["self"]> = {}, targets: ReferenceTarget[] = [api]): AnalyzeContext => ({
  self: { serviceId: "svc0000000000web", name: "web", nodes: [node], builtins: builtins(web), ...self },
  targets,
});

const render = (ctx: AnalyzeContext, kind = "app", reveal = false, builtFromRepository = false) =>
  renderStatic(() => (
    <TooltipProvider>
      <ReferencesPanel
        context={ctx}
        serviceKind={kind}
        projectId="prj0000000000001"
        reveal={reveal}
        builtFromRepository={builtFromRepository}
        onInsert={() => {}}
      />
    </TooltipProvider>
  ));

/** The chip names in the markup, in order. */
const chips = (html: string) => [...html.matchAll(/<button type="button"[^>]*>([A-Z_]+)<\/button>/g)].map((m) => m[1]);

/** The group names (the bold text of each group header), in order. */
const groups = (html: string) => [...html.matchAll(/<b class="font-semibold">([^<]+)<\/b>/g)].map((m) => m[1]);

/** The chips of one group: from its header to the next one. */
const chipsOf = (html: string, group: string) => {
  const start = html.indexOf(`<b class="font-semibold">${group}</b>`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('<b class="font-semibold">', start + 1);
  return chips(html.slice(start, next === -1 ? undefined : next));
};

test("the service itself comes first, with its built-ins and none of its own variables", async () => {
  const out = await render(context());
  const self = out.indexOf(`>${t("serviceEnv.refs.thisService")}<`);
  const name = out.indexOf('<b class="font-semibold">web</b>');
  expect(name).toBeGreaterThan(-1);
  expect(name).toBeLessThan(self);
  expect(out.indexOf('<b class="font-semibold">api</b>')).toBeGreaterThan(self);
  // Its APP badge, then the same chips as any other group.
  expect(out.slice(0, self)).toContain(">APP<");
  expect(groups(out)).toEqual(["web", "api"]);
  // web has no domain yet: its URL and DOMAIN have no chip.
  expect(chipsOf(out, "web")).toEqual(["INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT"]);
  // api keeps its own variable; the edited service never lists one (the lines of its file).
  expect(chipsOf(out, "api")).toEqual(["URL", "DOMAIN", "INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT", "PUBLIC_NAME"]);
  // Its internal address works from where it runs: nothing is struck through.
  expect(out).not.toContain('aria-disabled="true"');
});

test("a database lists its own database set under its engine's badge", async () => {
  const values = {
    INTERNAL_URL: "postgres://postgres:pw@db:5432/shop",
    INTERNAL_HOST: "db",
    INTERNAL_PORT: "5432",
    EXPOSED_URL: "postgres://postgres:pw@203.0.113.10:15432/shop?sslmode=require",
    EXPOSED_HOST: "203.0.113.10",
    EXPOSED_PORT: "15432",
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

test("a built-in that is empty right now gets no chip, the service's own and another service's", async () => {
  // worker has no domain and no port yet: only its host name has a value.
  const worker = service("worker", builtins({ INTERNAL_HOST: "worker" }));
  const out = await render(context({}, [worker, api]));
  expect(groups(out)).toEqual(["web", "worker", "api"]);
  expect(chipsOf(out, "web")).toEqual(["INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT"]);
  expect(chipsOf(out, "worker")).toEqual(["INTERNAL_HOST"]);
  // The same names with a value keep their chips.
  expect(chipsOf(out, "api")).toEqual(["URL", "DOMAIN", "INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT", "PUBLIC_NAME"]);
  // A database not exposed yet: no EXPOSED_* chips.
  const db = service(
    "db",
    builtins(
      {
        INTERNAL_URL: "postgres://postgres:pw@db:5432/shop",
        INTERNAL_HOST: "db",
        INTERNAL_PORT: "5432",
        USER: "postgres",
        PASSWORD: "pw",
        DATABASE: "shop",
      },
      databaseVariables,
    ),
    { serviceKind: "postgres" },
  );
  expect(chipsOf(await render(context({}, [db])), "db")).toEqual([
    "INTERNAL_URL",
    "INTERNAL_HOST",
    "INTERNAL_PORT",
    "USER",
    "PASSWORD",
    "DATABASE",
  ]);
});

test("an empty shared variable gets no chip", async () => {
  const out = await render(context({}, [shared({ SMTP_HOST: "smtp.example.com", SMTP_USER: "", SMTP_PASS: "" })]));
  expect(groups(out)).toEqual(["web", t("serviceEnv.refs.project")]);
  expect(chipsOf(out, t("serviceEnv.refs.project"))).toEqual(["SMTP_HOST"]);
});

test("a value the caller may not see is not empty: it keeps its chip, with or without Show values", async () => {
  // Without databases.credentials the database's PASSWORD and URLs come as null; without env.view
  // on api, its own variables too. A secret with a value is only masked.
  const db = service(
    "db",
    builtins(
      { INTERNAL_URL: null, INTERNAL_HOST: "db", INTERNAL_PORT: "5432", USER: "postgres", PASSWORD: null, DATABASE: "shop" },
      databaseVariables,
    ),
    { serviceKind: "postgres" },
  );
  const hiddenApi = { ...api, variables: api.variables.map((v) => (v.name === "PUBLIC_NAME" ? { ...v, value: null } : v)) };
  const ctx = context({}, [db, hiddenApi, shared({ SMTP_PASS: "pw", SMTP_TOKEN: null, SMTP_USER: "" })]);
  for (const reveal of [false, true]) {
    const out = await render(ctx, "app", reveal);
    expect(chipsOf(out, "db")).toEqual(["INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT", "USER", "PASSWORD", "DATABASE"]);
    expect(chipsOf(out, "api")).toContain("PUBLIC_NAME");
    expect(chipsOf(out, t("serviceEnv.refs.project"))).toEqual(["SMTP_PASS", "SMTP_TOKEN"]);
  }
  const url = { name: "URL", value: "", scope: "public" as const, sensitive: false, description: "" };
  expect(hasValue(url)).toBe(false);
  expect(hasValue({ ...url, value: null })).toBe(true);
});

test("without databases.credentials, a database not exposed still has no EXPOSED_URL chip", async () => {
  // env.references nulls PASSWORD and the URLs for this caller, EXPOSED_URL also while it is empty;
  // EXPOSED_HOST and EXPOSED_PORT are not credentials and come as "".
  const hidden = {
    INTERNAL_URL: null,
    INTERNAL_HOST: "db",
    INTERNAL_PORT: "5432",
    EXPOSED_URL: null,
    USER: "postgres",
    PASSWORD: null,
    DATABASE: "shop",
  };
  const kept = ["INTERNAL_URL", "INTERNAL_HOST", "INTERNAL_PORT", "USER", "PASSWORD", "DATABASE"];
  const db = service("db", builtins(hidden, databaseVariables), { serviceKind: "postgres" });
  expect(chipsOf(await render(context({}, [db])), "db")).toEqual(kept);
  // The database's own tab: its "this service" group too.
  const own = await render(context({ name: "db", builtins: builtins(hidden, databaseVariables) }, []), "postgres");
  expect(chipsOf(own, "db")).toEqual(kept);
  // Exposed: EXPOSED_HOST has a value, so the null EXPOSED_URL is hidden, not empty, and keeps its chip.
  const exposedValues = { ...hidden, EXPOSED_HOST: "203.0.113.10", EXPOSED_PORT: "15432" };
  const exposed = service("db", builtins(exposedValues, databaseVariables), { serviceKind: "postgres", exposed: true });
  expect(chipsOf(await render(context({}, [exposed])), "db")).toEqual(databaseVariables.map((v) => v.name));
  // Only a database's: an app's own EXPOSED_URL the caller may not see keeps its chip next to an empty EXPOSED_HOST.
  const ownVariable = (name: string, value: string | null): ReferenceVariable => ({
    name,
    value,
    scope: "plain",
    sensitive: true,
    description: "variable of this service",
  });
  const app = service("app", [...builtins({ INTERNAL_HOST: "app" }), ownVariable("EXPOSED_URL", null), ownVariable("EXPOSED_HOST", "")]);
  expect(chipsOf(await render(context({}, [app])), "app")).toEqual(["INTERNAL_HOST", "EXPOSED_URL"]);
});

test("a group with no chip left is not shown", async () => {
  const empty = service("empty", builtins({}));
  const out = await render(context({}, [empty, api, shared({ SMTP_HOST: "", SMTP_USER: "" })]));
  expect(groups(out)).toEqual(["web", "api"]);
  expect(out).not.toContain(t("serviceEnv.refs.shared"));
  expect(out).not.toContain(t("serviceEnv.refs.emptyOthers"));
  // A service with no chip of its own left: no "this service" group either.
  const noSelf = await render(context({ builtins: builtins({}) }, [api]));
  expect(noSelf).not.toContain(t("serviceEnv.refs.thisService"));
  expect(groups(noSelf)).toEqual(["api"]);
});

test("nothing left with a value: the panel's empty state", async () => {
  const blank = [service("empty", builtins({})), shared({ SMTP_HOST: "" })];
  // Only the service's own chips left: the hint that others show up here.
  const others = await render(context({}, blank));
  expect(groups(others)).toEqual(["web"]);
  expect(others).toContain(t("serviceEnv.refs.emptyOthers"));
  // Not even those: nothing to reference yet.
  const none = await render(context({ builtins: builtins({}) }, blank));
  expect(groups(none)).toEqual([]);
  expect(chips(none)).toEqual([]);
  expect(none).toContain(t("serviceEnv.refs.empty"));
});

test("a service on another node with no way in, only its internal address left: the Expose link", async () => {
  // No domain and no port yet: URL, DOMAIN, INTERNAL_URL and INTERNAL_PORT are empty, the host name is internal.
  const worker = service("worker", builtins({ INTERNAL_HOST: "worker" }), { nodes: [other] });
  const out = await render(context({}, [worker]));
  expect(groups(out)).toEqual(["web", "worker"]);
  expect(chipsOf(out, "worker")).toEqual([]);
  expect(out).toContain(t("serviceEnv.fix.expose", { service: "worker" }));
});

test("the tip's value line: the value, or why it is not shown", () => {
  const domain = { name: "DOMAIN", value: "web.example.com", scope: "public" as const, sensitive: false, description: "" };
  expect(shownValue(domain, false)).toBe("web.example.com");
  expect(shownValue({ ...domain, value: null }, false)).toBe(t("serviceEnv.hover.unknown"));
  const password = { ...domain, name: "PASSWORD", value: "pw", sensitive: true };
  expect(shownValue(password, false)).toBe(t("serviceEnv.hover.hidden"));
  expect(shownValue(password, true)).toBe("pw");
});

test("a service built from a repository is told about GIT_SHA next to its references", async () => {
  // Before 0.2.14 nothing set GIT_SHA, and nothing said so.
  expect(await render(context(), "app", false, true)).toContain("GIT_SHA, the commit this deployment was built from");
  expect(await render(context(), "app", false, false)).not.toContain("GIT_SHA");
  // Also with nothing else to reference yet.
  expect(await render(context({ builtins: undefined }, []), "app", false, true)).toContain("GIT_SHA");
});

test("repository sources are the ones whose deploys build a commit", () => {
  for (const type of ["github", "provider", "git"]) expect(buildsFromRepository({ type })).toBe(true);
  for (const type of ["image", "inline", "upload", "none"]) expect(buildsFromRepository({ type })).toBe(false);
});
