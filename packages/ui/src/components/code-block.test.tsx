import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock } from "./code-block";

const pre = (html: string) => html.match(/<pre class="([^"]*)"/)?.[1] ?? "";

test("code wraps by default, so a long command or value never sits off screen", () => {
  const command =
    "claude mcp add --transport http panel https://panel.example.com/api/mcp --header 'Authorization: Bearer sk_live_0123456789abcdef'";
  const classes = pre(renderToStaticMarkup(<CodeBlock code={command} tone="dark" />));
  expect(classes).toContain("whitespace-pre-wrap");
  // Breaks inside a long token too (a URL or a key), not only at spaces.
  expect(classes).toContain("[overflow-wrap:anywhere]");
  expect(classes.split(" ")).not.toContain("whitespace-pre");
});

test("noWrap keeps lines whole and scrolls sideways", () => {
  const classes = pre(renderToStaticMarkup(<CodeBlock code="a b" noWrap />)).split(" ");
  expect(classes).toContain("whitespace-pre");
  expect(classes).not.toContain("whitespace-pre-wrap");
});

test("without a title, Copy sits outside the scrolling code, so it stays in view in a long block", () => {
  const html = renderToStaticMarkup(<CodeBlock code={"line\n".repeat(40)} maxHeight={260} />);
  const [inside = "", after = ""] = html.split("</pre>");
  // In the code only a hidden gap the first lines flow around, never a button.
  expect(inside).not.toContain("<button");
  expect(inside).toContain('aria-hidden="true"');
  expect(after).toContain("<button");
  expect(after).toContain("absolute");
  // With a title it stays in the title bar.
  const titled = renderToStaticMarkup(<CodeBlock code="x" title="bash" />);
  expect(titled.split("<pre")[0]).toContain("<button");
});
