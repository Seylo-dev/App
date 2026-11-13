import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogBuffer } from "../lib/log-buffer";
import { CodeBlock, CopyCode } from "./code-block";
import { contextMenuDecision, isMenuKey, type MenuRequest, nativeMenuTargets, wantsNativeMenu } from "./context-menu";
import { CopyField } from "./copy-field";
import { DataTable, rowActionEntries } from "./data-table";
import { LogViewer } from "./log-viewer";
import { ActionsMenu, entryIds, type MenuEntry, menuElements, menuParts, RowContextMenu, tidyEntries } from "./menu-items";

const noop = () => {};
const item = (id: string, extra: Partial<Extract<MenuEntry, { type: "item" }>> = {}): MenuEntry => ({
  type: "item",
  id,
  label: id,
  onSelect: noop,
  ...extra,
});
const sep = (id: string): MenuEntry => ({ type: "separator", id });

describe("tidyEntries", () => {
  test("drops separators at the start, the end and right after another", () => {
    const out = tidyEntries([sep("a"), item("open"), sep("b"), sep("c"), item("copy"), sep("d")]);
    expect(out.map((e) => e.id)).toEqual(["open", "b", "copy"]);
  });

  test("drops a sub menu whose entries all went, and tidies the ones that stay", () => {
    const out = tidyEntries([
      item("open"),
      sep("a"),
      { type: "sub", id: "empty", label: "Empty", entries: [sep("x")] },
      sep("b"),
      { type: "sub", id: "new", label: "New", entries: [sep("y"), item("app"), sep("z")] },
    ]);
    expect(out.map((e) => e.id)).toEqual(["open", "a", "new"]);
    const sub = out[2] as Extract<MenuEntry, { type: "sub" }>;
    expect(sub.entries.map((e) => e.id)).toEqual(["app"]);
  });

  test("an all-separator list is empty, so no menu shows", () => {
    expect(tidyEntries([sep("a"), sep("b")])).toEqual([]);
  });
});

test("entryIds lists what can be chosen, sub menus' entries after them", () => {
  expect(
    entryIds([
      item("open"),
      sep("a"),
      { type: "label", id: "why", label: "Why" },
      { type: "sub", id: "new", label: "New", entries: [item("app"), item("db")] },
    ]),
  ).toEqual(["open", "new", "app", "db"]);
});

describe("the browser's menu or ours", () => {
  const row: MenuRequest = { button: 2, shiftKey: false, target: "row", hasSelection: false };
  test.each<[string, Partial<MenuRequest>, ReturnType<typeof contextMenuDecision>]>([
    ["a right-click on the row", {}, "ours"],
    ["Shift+right-click", { shiftKey: true }, "native"],
    ["Shift+F10 (the keyboard reports button 0)", { button: 0, shiftKey: true }, "ours"],
    ["the context menu key", { button: 0 }, "ours"],
    ["a text field, editor or terminal", { target: "field" }, "native"],
    ["text selected in the row", { hasSelection: true }, "native"],
    ["a dialog rendered inside the row", { target: "portal" }, "native"],
    ["the drag grip", { target: "grip" }, "none"],
    ["the grip with Shift+F10", { target: "grip", button: 0, shiftKey: true }, "none"],
    ["inside an open menu", { target: "menu" }, "none"],
    ["while a drag is on", { blocked: true }, "none"],
    ["a text field while a drag is on", { target: "field", blocked: true }, "none"],
  ])("%s", (_name, change, expected) => {
    const request = { ...row, ...change };
    expect(contextMenuDecision(request)).toBe(expected);
    expect(wantsNativeMenu(request)).toBe(expected === "native");
  });
});

test("the context menu key and Shift+F10 ask for the menu, nothing else does", () => {
  expect(isMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
  expect(isMenuKey({ key: "F10", shiftKey: true })).toBe(true);
  expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  expect(isMenuKey({ key: "F10", shiftKey: true, ctrlKey: true })).toBe(false);
  expect(isMenuKey({ key: "Enter", shiftKey: true })).toBe(false);
});

describe("the dropdown and the context menu list the same things", () => {
  const entries: MenuEntry[] = [
    item("open", { icon: "icon", shortcut: "O" }),
    sep("one"),
    item("deploy", { disabled: true, disabledReason: "A deploy is in progress." }),
    item("redeploy", { disabled: true, disabledReason: "A deploy is in progress." }),
    { type: "checkbox", id: "pin", label: "Pin", checked: true, onCheckedChange: noop },
    { type: "sub", id: "new", label: "New service", entries: [item("app"), item("db")] },
    sep("two"),
    { type: "label", id: "note", label: "A note" },
    item("delete", { destructive: true }),
  ];

  /** Element type name and props, minus children, for every element down the tree. */
  function shape(elements: readonly ReactElement[], as: "dropdown" | "context"): unknown[] {
    const parts = menuParts[as] as unknown as Record<string, unknown>;
    const partName = (type: unknown) => Object.keys(parts).find((name) => parts[name] === type) ?? "other";
    return elements.map((element) => {
      const { children, ...raw } = element.props as Record<string, unknown>;
      // Handlers made per render compare as "a function".
      const props = Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, typeof value === "function" ? "fn" : value]));
      const kids = (Array.isArray(children) ? children : [children]).filter(isValidElement) as ReactElement[];
      return { part: partName(element.type), key: element.key, props, children: shape(kids, as) };
    });
  }

  test("same parts, keys and props in the same order; only the kind of part differs", () => {
    const dropdown = menuElements("dropdown", entries);
    const context = menuElements("context", entries);
    expect(shape(dropdown, "dropdown")).toEqual(shape(context, "context"));
    // Every element is that menu's own part, never the other kind's.
    for (const element of dropdown) expect(Object.values(menuParts.context)).not.toContain(element.type);
    for (const element of context) expect(Object.values(menuParts.dropdown)).not.toContain(element.type);
  });

  test("disabled items keep their flag and the reason shows once at the end", () => {
    const shown = shape(menuElements("context", entries), "context") as { part: string; key: string; props: Record<string, unknown> }[];
    const deploy = shown.find((e) => e.key === "deploy");
    expect(deploy?.props.disabled).toBe(true);
    expect(deploy?.props.title).toBe("A deploy is in progress.");
    const reasons = shown.filter((e) => String(e.key).startsWith("disabled-reason:"));
    expect(reasons.map((e) => e.key)).toEqual(["disabled-reason:A deploy is in progress."]);
    expect(shown.find((e) => e.key === "delete")?.props.destructive).toBe(true);
  });
});

test("a row with no entries keeps its element as it is (and the browser's menu)", () => {
  const out = renderToStaticMarkup(
    <RowContextMenu entries={[sep("a")]}>
      <a href="/p/x">api</a>
    </RowContextMenu>,
  );
  expect(out).toBe('<a href="/p/x">api</a>');
});

test("a row with entries becomes the trigger without a wrapper element", () => {
  const out = renderToStaticMarkup(
    <RowContextMenu entries={[item("open")]}>
      <a href="/p/x" className="row">
        api
      </a>
    </RowContextMenu>,
  );
  expect(out).toMatch(/^<a /);
  expect(out).toContain('data-context-menu-trigger=""');
  expect(out).toContain('data-state="closed"');
  expect(out).toContain("pointer-coarse:select-none");
  // The row keeps its own classes.
  expect(out).toContain("row");
});

test("an empty actions menu renders nothing", () => {
  expect(renderToStaticMarkup(<ActionsMenu entries={[]} label="More" />)).toBe("");
  expect(renderToStaticMarkup(<ActionsMenu entries={[item("open")]} label="More" />)).toContain('aria-label="More"');
});

test("a DataTable row with actions is its own right-click menu's trigger; one without stays a plain row", () => {
  const columns = [{ id: "name", header: "Name", cell: (row: { id: string }) => row.id }];
  const rows = [{ id: "a" }, { id: "b" }];
  const out = renderToStaticMarkup(
    <DataTable
      aria-label="Keys"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      rowActions={(row) => (row.id === "a" ? [{ label: "Revoke", onSelect: noop, destructive: true }] : [])}
    />,
  );
  const trs = out.match(/<tr[^>]*>/g) ?? [];
  // The header row, a with its menu, b without.
  expect(trs).toHaveLength(3);
  expect(trs[1]).toContain("data-context-menu-trigger");
  expect(trs[1]).toContain("data-[state=open]:bg-raised");
  expect(trs[2]).not.toContain("data-context-menu-trigger");
});

test("DataTable row actions become the same entries, separators where asked", () => {
  const entries = rowActionEntries([
    { label: "Open folder", onSelect: noop },
    { label: "Delete", onSelect: noop, destructive: true, separated: true },
  ]);
  expect(entries.map((e) => e.type)).toEqual(["item", "separator", "item"]);
  expect((entries[2] as Extract<MenuEntry, { type: "item" }>).destructive).toBe(true);
});

test("code, copy fields and logs keep the browser's menu, also inside a row with a right-click menu", () => {
  expect(nativeMenuTargets).toContain("[data-native-context-menu]");
  const outs = [
    renderToStaticMarkup(<CopyField value="postgres://db:5432/app" aria-label="URL" />),
    renderToStaticMarkup(<CodeBlock code="seylo login" />),
    renderToStaticMarkup(<CopyCode code="npm start" />),
    renderToStaticMarkup(<LogViewer buffer={new LogBuffer(10)} aria-label="Logs" />),
  ];
  for (const out of outs) expect(out).toContain('data-native-context-menu=""');
});

test("both menus build on the same shared classes", async () => {
  const dropdown = await Bun.file(new URL("./dropdown-menu.tsx", import.meta.url)).text();
  const context = await Bun.file(new URL("./context-menu.tsx", import.meta.url)).text();
  for (const source of [dropdown, context]) {
    expect(source).toContain('from "../lib/menu-styles"');
    for (const name of ["menuSurface", "menuItem", "menuItemDestructive", "menuLabel", "menuSeparator", "menuShortcut"])
      expect(source).toContain(`${name},`);
    // No class string of their own for the surface or the items.
    expect(source).not.toContain("rounded-chip px-2.5 py-[7px]");
    expect(source).not.toContain("bg-popover");
  }
});
