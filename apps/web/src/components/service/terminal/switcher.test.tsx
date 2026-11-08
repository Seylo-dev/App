import { expect, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { Switcher } from "./console-pages";

async function render(current: "console" | "shell") {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Switcher service={{ id: "svc-1", projectId: "prj-1" }} current={current} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The links of the switch, in order, as markup. */
const links = (html: string) => [...html.matchAll(/<a\b[^>]*>.*?<\/a>/g)].map((m) => m[0]);

test("the current Console | Shell item holds the sliding background, not a painted one", async () => {
  for (const current of ["console", "shell"] as const) {
    const [consoleLink, shellLink] = links(await render(current));
    const [on, off] = current === "console" ? [consoleLink, shellLink] : [shellLink, consoleLink];
    // One shared indicator inside the current item; before, the current link painted bg-terminal-field itself.
    expect(on).toContain('data-slot="active-indicator"');
    expect(on).toContain('aria-current="page"');
    expect(on).toMatch(/class="[^"]*\brelative isolate\b/);
    expect(on).not.toMatch(/<a\b[^>]*class="[^"]*bg-terminal-field/);
    expect(off).not.toContain('data-slot="active-indicator"');
    expect(off).not.toContain("aria-current");
  }
});
