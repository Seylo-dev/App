import { expect, test } from "bun:test";
import { approvals, auth, system } from "@seylo/ops";
import type { ComponentType } from "react";
import { t } from "../../i18n/t";
import { hiddenSidebarItems, withSidebarItem } from "../../lib/use-sidebar-items";
import { Route as PreferencesRoute } from "../../routes/_app/settings/preferences";
import { type Answer, renderStatic } from "../../test/render";
import { mainNav } from "./nav-items";
import { MainNavLinks } from "./sidebar";
import { useMainNav } from "./use-main-nav";

// Settings > Preferences turns main navigation items off per person
// (auth.preferences.hiddenSidebarItems). The sidebar's links (MainNavLinks,
// on a phone too: the same list under the menu button) leave them out; the
// command palette and the pages ignore the list.

const prefs = (hiddenSidebarItems?: string[]): Answer => [
  auth.preferences,
  {},
  { preferences: hiddenSidebarItems ? { hiddenSidebarItems } : {} },
];
const features = (on: boolean): Answer => [system.features, {}, { mcp: { enabled: on, reason: "" }, ai: { enabled: false, reason: "" } }];
const pending = (pendingCount: number): Answer => [
  approvals.list,
  { status: "pending", limit: 1 },
  { approvals: [], nextCursor: null, pendingCount },
];

const sidebar = (answers: Answer[]) => renderStatic(() => <MainNavLinks nodeCount={3} />, answers);

/** The main navigation links' text, badges included ("Approvals2"), in order. */
function navLinks(html: string): string[] {
  const labels = mainNav.map((item) => t(item.label));
  return [...html.matchAll(/<a\b[^>]*>(.*?)<\/a>/g)]
    .map((match) => (match[1] ?? "").replace(/<[^>]+>/g, ""))
    .filter((text) => labels.some((label) => text.startsWith(label) && /^\d*$/.test(text.slice(label.length))));
}

test("hiddenSidebarItems reads the list (none when missing); withSidebarItem adds at the end and never twice", () => {
  expect([...hiddenSidebarItems(undefined)]).toEqual([]);
  expect([...hiddenSidebarItems({})]).toEqual([]);
  expect([...hiddenSidebarItems({ hiddenSidebarItems: ["templates", "activity"] })]).toEqual(["templates", "activity"]);
  expect(withSidebarItem([], "templates", false)).toEqual(["templates"]);
  expect(withSidebarItem(["templates"], "activity", false)).toEqual(["templates", "activity"]);
  expect(withSidebarItem(["activity", "templates"], "activity", false)).toEqual(["templates", "activity"]);
  expect(withSidebarItem(["templates", "activity"], "templates", true)).toEqual(["activity"]);
  expect(withSidebarItem([], "templates", true)).toEqual([]);
});

test("the sidebar lists every item by default and leaves out the ones turned off", async () => {
  const all = await sidebar([prefs(), features(true), pending(0)]);
  expect(navLinks(all)).toEqual(["Dashboard", "Nodes3", "Templates", "Activity", "Approvals", "Settings"]);

  const some = await sidebar([prefs(["templates", "activity"]), features(true), pending(0)]);
  expect(navLinks(some)).toEqual(["Dashboard", "Nodes3", "Approvals", "Settings"]);
  expect(some).not.toContain('href="/templates"');
  expect(some).not.toContain('href="/activity"');
});

test("Settings always stays, even with every other item off", async () => {
  const out = await sidebar([prefs([...auth.sidebarItems, "settings"]), features(true), pending(0)]);
  expect(navLinks(out)).toEqual(["Settings"]);
  expect(out).toContain('href="/settings"');
});

test("Approvals turned off comes back while a request waits, with its count", async () => {
  const idle = await sidebar([prefs(["approvals"]), features(true), pending(0)]);
  expect(navLinks(idle)).not.toContain("Approvals");
  const waiting = await sidebar([prefs(["approvals"]), features(true), pending(2)]);
  expect(navLinks(waiting)).toContain("Approvals2");
});

test("only hides: Approvals left on stays out while MCP and the assistant are off and nothing waits", async () => {
  const out = await sidebar([prefs([]), features(false), pending(0)]);
  expect(navLinks(out)).toEqual(["Dashboard", "Nodes3", "Templates", "Activity", "Settings"]);
});

test("until the preferences answer, placeholders instead of items that may be turned off", async () => {
  const out = await sidebar([features(true), pending(0)]);
  expect(navLinks(out)).toEqual([]);
  expect(out).toContain('role="status"');
  expect(out).toContain('data-slot="skeleton"');
});

/** The list the command palette's "Go to" group reads. */
function PaletteItems() {
  return (
    <ul>
      {useMainNav().items.map((item) => (
        <li key={item.id}>{`go:${item.id}`}</li>
      ))}
    </ul>
  );
}

test("the command palette's list (useMainNav) keeps items turned off in the sidebar", async () => {
  const out = await renderStatic(() => <PaletteItems />, [prefs(["templates", "activity", "approvals"]), features(true), pending(0)]);
  for (const id of ["dashboard", "nodes", "templates", "activity", "approvals", "settings"]) expect(out).toContain(`go:${id}`);
});

const PreferencesPage = PreferencesRoute.options.component as ComponentType;

test("Settings > Preferences: a switch per item but Settings, on unless turned off, and Approvals says it shows while a request waits", async () => {
  const out = await renderStatic(() => <PreferencesPage />, [prefs(["templates"]), features(true)]);
  for (const item of mainNav) {
    const label = `aria-label="${t("settingsPreferences.sidebar.showItem", { name: t(item.label) })}"`;
    if (item.id === "settings") expect(out).not.toContain(label);
    else expect(out).toContain(label);
  }
  expect(out).toMatch(/role="switch" aria-checked="false"[^>]*aria-label="Show Templates in the sidebar"/);
  expect(out).toMatch(/role="switch" aria-checked="true"[^>]*aria-label="Show Activity in the sidebar"/);
  expect(out).toContain(t("settingsPreferences.sidebar.approvalsHint"));
  // The hidden-projects switch is still there, after the items.
  expect(out.indexOf(t("settingsPreferences.sidebar.showHidden"))).toBeGreaterThan(out.indexOf("Show Approvals in the sidebar"));

  // While nothing can ask for an approval, the hint says when Approvals shows at all.
  const idle = await renderStatic(() => <PreferencesPage />, [prefs(), features(false)]);
  expect(idle).toContain(t("settingsPreferences.sidebar.approvalsHintIdle"));
  expect(idle).not.toMatch(/role="switch" aria-checked="false"/);
});
