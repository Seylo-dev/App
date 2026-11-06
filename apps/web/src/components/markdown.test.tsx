import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeUrl } from "./markdown";

test("renders Markdown with GitHub extensions", () => {
  const html = renderToStaticMarkup(<Markdown>{"## Runbook\n\n- [x] done\n- `cache:stats`\n\n| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);
  expect(html).toContain("<h4");
  expect(html).toContain("Runbook");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("<code");
  expect(html).toContain("<table");
});

test("raw HTML and script links never reach the page", () => {
  const html = renderToStaticMarkup(
    <Markdown>
      {'<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1)) [ok](https://example.com)'}
    </Markdown>,
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('rel="noopener noreferrer nofollow"');
  expect(safeUrl("javascript:alert(1)")).toBe("");
});

test("images become links instead of loading", () => {
  const html = renderToStaticMarkup(<Markdown>{"![diagram](https://example.com/a.png)"}</Markdown>);
  expect(html).not.toContain("<img");
  expect(html).toContain('href="https://example.com/a.png"');
  expect(html).toContain("diagram");
});
