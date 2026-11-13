// The sidebar's and the dashboard's saves of the person's order and folded
// projects (each view folds with its own flag), over the app's own query
// cache: a change is patched into the cached list at once.
// A read of that list already on its way (a live event refetches it about
// once a second while a service deploys) was asked before the save, so its
// answer must not put the old order back; once the save answered, the list
// is read again, but not while another save of it is still on its way.

import { afterEach, expect, test } from "bun:test";
import { projects, services } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryClient } from "./api";
import type { Project, ServiceSummary } from "./types";
import { useProjectPrefs } from "./use-project-prefs";

/** A save the test answers. */
type Save = { op: string; input: Record<string, unknown>; answer(value: unknown): Promise<void>; fail(error: unknown): Promise<void> };

/** Lets the mutation's callbacks and the cache's updates run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let captured: ReturnType<typeof useProjectPrefs> | undefined;

function Capture() {
  captured = useProjectPrefs();
  return null;
}

/** The hook as the sidebar gets it, over the app's query cache, with an op client whose answers the test gives. */
function prefs(saves: Save[]) {
  const client = {
    call: (op: { id: string }, input: Record<string, unknown>) =>
      new Promise((resolve, reject) =>
        saves.push({
          op: op.id,
          input,
          answer: async (value) => {
            resolve(value);
            await settle();
          },
          fail: async (error) => {
            reject(error);
            await settle();
          },
        }),
      ),
  } as unknown as OpClient;
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={client}>
        <Capture />
      </OpClientProvider>
    </QueryClientProvider>,
  );
  if (!captured) throw new Error("useProjectPrefs did not render");
  return captured;
}

/** A read of `key` on its way, the way a live event's refetch is: it answers when the test says, with what it read then. */
function readOnItsWay(key: QueryKey) {
  let answer: (value: unknown) => void = () => {};
  const read = new Promise((resolve) => {
    answer = resolve;
  });
  void queryClient.fetchQuery({ queryKey: key, queryFn: () => read, staleTime: 0 }).catch(() => {});
  return async (value: unknown) => {
    answer(value);
    await settle();
  };
}

const project = (id: string, collapsed = false, dashboardCollapsed = false) =>
  ({ id, name: id, collapsed, dashboardCollapsed }) as unknown as Project;
const service = (id: string) => ({ id, name: id, parentId: null }) as unknown as ServiceSummary;

const projectsKey = opQueryKey(projects.list, {});
const servicesKey = (projectId: string) => opQueryKey(services.list, { projectId });
const projectOrder = () => queryClient.getQueryData<{ projects: Project[] }>(projectsKey)?.projects.map((p) => p.id);
const serviceOrder = (projectId: string) =>
  queryClient.getQueryData<{ services: ServiceSummary[] }>(servicesKey(projectId))?.services.map((s) => s.id);
/** Each project's [sidebar, home page] flags in the cached list. */
const flags = () =>
  queryClient.getQueryData<{ projects: Project[] }>(projectsKey)?.projects.map((p) => [p.id, p.collapsed, p.dashboardCollapsed]);
/** Whether the list is due to be read again (a screen showing it would read it now). */
const readAgain = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated === true;

afterEach(() => {
  queryClient.removeQueries({ queryKey: ["op"] });
  queryClient.getMutationCache().clear();
});

test("a service order dropped while the list is being read again stays: that read's answer is from before the save", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  const before = { services: [service("web"), service("api"), service("db")] };
  queryClient.setQueryData(servicesKey("p1"), before);
  const answerRead = readOnItsWay(servicesKey("p1"));

  hook.setServiceOrder("p1", ["db", "web", "api"]);
  expect(serviceOrder("p1")).toEqual(["db", "web", "api"]);
  await answerRead(before);
  expect(serviceOrder("p1")).toEqual(["db", "web", "api"]);
  expect(saves.map((s) => s.op)).toEqual([services.reorder.id]);
});

test("a project order dropped (sidebar, dashboard or Move before) while projects.list is being read stays", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  const before = { projects: [project("acme"), project("personal"), project("panel")] };
  queryClient.setQueryData(projectsKey, before);

  let answerRead = readOnItsWay(projectsKey);
  hook.setProjectOrder(["personal", "acme", "panel"]);
  await answerRead(before);
  expect(projectOrder()).toEqual(["personal", "acme", "panel"]);

  answerRead = readOnItsWay(projectsKey);
  hook.moveBefore("panel", "personal");
  await answerRead(before);
  expect(projectOrder()).toEqual(["panel", "personal", "acme"]);
});

test("a project folded while projects.list is being read stays folded, in the sidebar and on the home page", async () => {
  const hook = prefs([]);
  const before = { projects: [project("acme"), project("personal")] };
  queryClient.setQueryData(projectsKey, before);
  let answerRead = readOnItsWay(projectsKey);

  hook.setCollapsed("acme", true, "sidebar");
  await answerRead(before);
  expect(flags()).toEqual([
    ["acme", true, false],
    ["personal", false, false],
  ]);

  answerRead = readOnItsWay(projectsKey);
  hook.setCollapsed("personal", true, "dashboard");
  await answerRead(before);
  expect(flags()).toEqual([
    ["acme", true, false],
    ["personal", false, true],
  ]);
});

test("the sidebar's chevron changes only the sidebar's flag, the home page's only its own, each saved with where", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  queryClient.setQueryData(projectsKey, { projects: [project("acme", false, true), project("personal", true, false)] });

  hook.setCollapsed("acme", true, "sidebar");
  hook.setCollapsed("personal", true, "dashboard");
  expect(flags()).toEqual([
    ["acme", true, true],
    ["personal", true, true],
  ]);
  hook.setCollapsed("acme", false, "dashboard");
  hook.setCollapsed("personal", false, "sidebar");
  expect(flags()).toEqual([
    ["acme", true, false],
    ["personal", false, true],
  ]);
  // The saves reach the op client a moment later.
  await settle();
  expect(saves.map((s) => [s.op, s.input])).toEqual([
    [projects.setCollapsed.id, { projectId: "acme", collapsed: true, where: "sidebar" }],
    [projects.setCollapsed.id, { projectId: "personal", collapsed: true, where: "dashboard" }],
    [projects.setCollapsed.id, { projectId: "acme", collapsed: false, where: "dashboard" }],
    [projects.setCollapsed.id, { projectId: "personal", collapsed: false, where: "sidebar" }],
  ]);
});

test("Collapse all and Expand all on the home page fold its own flags of the cards on screen, and save only the ones that change", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  // acme is folded in the sidebar only; panel is hidden (not on screen).
  queryClient.setQueryData(projectsKey, { projects: [project("acme", true, false), project("personal", false, true), project("panel")] });

  hook.setAllCollapsed(true, "dashboard", [{ id: "acme" }, { id: "personal" }]);
  expect(flags()).toEqual([
    ["acme", true, true],
    ["personal", false, true],
    ["panel", false, false],
  ]);
  hook.setAllCollapsed(false, "dashboard", [{ id: "acme" }, { id: "personal" }]);
  expect(flags()).toEqual([
    ["acme", true, false],
    ["personal", false, false],
    ["panel", false, false],
  ]);
  await settle();
  expect(saves.map((s) => s.input)).toEqual([
    { projectId: "acme", collapsed: true, where: "dashboard" },
    { projectId: "acme", collapsed: false, where: "dashboard" },
    { projectId: "personal", collapsed: false, where: "dashboard" },
  ]);
});

test("once the save answered the services are read again, but not while a second drop's save is on its way", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  queryClient.setQueryData(servicesKey("p1"), { services: [service("web"), service("api"), service("db")] });
  queryClient.setQueryData(servicesKey("p2"), { services: [service("cache"), service("queue")] });

  hook.setServiceOrder("p1", ["api", "web", "db"]);
  hook.setServiceOrder("p1", ["db", "api", "web"]);
  hook.setServiceOrder("p2", ["queue", "cache"]);
  // The saves reach the op client a moment later.
  await settle();
  const [first, second, other] = saves;
  if (!first || !second || !other) throw new Error("three saves expected");

  // A read after the first save could miss the second one and show the first drop's order for a moment.
  await first.answer({ projectId: "p1", serviceIds: ["api", "web", "db"] });
  expect(readAgain(servicesKey("p1"))).toBe(false);
  expect(serviceOrder("p1")).toEqual(["db", "api", "web"]);
  // Another project's save does not wait for this one.
  await other.answer({ projectId: "p2", serviceIds: ["queue", "cache"] });
  expect(readAgain(servicesKey("p2"))).toBe(true);
  await second.answer({ projectId: "p1", serviceIds: ["db", "api", "web"] });
  expect(readAgain(servicesKey("p1"))).toBe(true);
});

test("once the saves answered projects.list is read again; a fold and a drop are both saves of it", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  queryClient.setQueryData(projectsKey, { projects: [project("acme"), project("personal")] });

  hook.setCollapsed("acme", true, "sidebar");
  hook.setProjectOrder(["personal", "acme"]);
  // The saves reach the op client a moment later.
  await settle();
  const [fold, drop] = saves;
  if (!fold || !drop) throw new Error("two saves expected");
  await drop.answer({ projectIds: ["personal", "acme"] });
  expect(readAgain(projectsKey)).toBe(false);
  await fold.answer({ projectId: "acme", collapsed: true, where: "sidebar" });
  expect(readAgain(projectsKey)).toBe(true);
});

test("a failed save reads the list again at once, which puts the panel's order back", async () => {
  const saves: Save[] = [];
  const hook = prefs(saves);
  queryClient.setQueryData(servicesKey("p1"), { services: [service("web"), service("api")] });

  hook.setServiceOrder("p1", ["api", "web"]);
  hook.setServiceOrder("p1", ["web", "api"]);
  // The saves reach the op client a moment later.
  await settle();
  const [first] = saves;
  if (!first) throw new Error("a save expected");
  await first.fail(new Error("The database is locked."));
  expect(readAgain(servicesKey("p1"))).toBe(true);
});
