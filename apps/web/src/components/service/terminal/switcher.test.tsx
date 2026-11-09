import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TerminalMode } from "./access";
import { ModeSwitch } from "./console-pages";

const render = (mode: TerminalMode, modes: readonly TerminalMode[]) =>
  renderToStaticMarkup(<ModeSwitch mode={mode} modes={modes} onChange={() => {}} />);

/** The switch's items, in order, as markup. */
const items = (html: string) => [...html.matchAll(/<button\b[^>]*>.*?<\/button>/g)].map((m) => m[0]);

test("Console | Shell switches in place: one radio group, the current item holds the sliding background", () => {
  for (const current of ["console", "shell"] as const) {
    const html = render(current, ["console", "shell"]);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Console or shell"');
    // Buttons, not links: the mode changes without leaving the page (before, each item was a Link to its own tab).
    expect(html).not.toContain("<a ");
    const [consoleItem = "", shellItem = ""] = items(html);
    expect(consoleItem).toContain(">Console");
    expect(shellItem).toContain(">Shell");
    const [on, off] = current === "console" ? [consoleItem, shellItem] : [shellItem, consoleItem];
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('data-slot="active-indicator"');
    expect(on).toMatch(/class="[^"]*\brelative isolate\b/);
    // The terminal's own colors, not the light track's white pill.
    expect(on).toContain("bg-terminal-field");
    expect(on).not.toContain("bg-card");
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('data-slot="active-indicator"');
  }
});

test("with one mode allowed the switch is only its name", () => {
  const html = render("console", ["console"]);
  expect(html).not.toContain("radiogroup");
  expect(html).not.toContain("<button");
  expect(html).toContain(">Console</span>");
  expect(render("shell", ["shell"])).toContain(">Shell</span>");
});
