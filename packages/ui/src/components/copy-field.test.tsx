import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyField } from "./copy-field";

const ring = [
  "has-[[data-slot=copy-field-value]:focus-visible]:outline-2",
  "has-[[data-slot=copy-field-value]:focus-visible]:outline-offset-2",
  "has-[[data-slot=copy-field-value]:focus-visible]:outline-ring",
];

/** The class list of the element that opens with `<tag data-slot="slot"`. */
function classesOf(out: string, tag: string, slot: string): string[] {
  const match = out.match(new RegExp(`<${tag} [^>]*data-slot="${slot}"[^>]*>`));
  if (!match) return [];
  return (match[0].match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
}

// The value button drops the browser outline (it is only the text inside the
// field), so the field must show keyboard focus for it. Before: nothing did,
// and tabbing onto a database URL or an API key left no visible focus.
test.each([
  ["card", false],
  ["terminal", false],
  ["card", true],
] as const)("keyboard focus on the value rings the whole field (%s, secret %p)", (tone, secret) => {
  const out = renderToStaticMarkup(
    <CopyField value="postgres://u:p@db:5432/app" tone={tone} secret={secret} aria-label="Connection URL" />,
  );
  const value = classesOf(out, "button", "copy-field-value");
  expect(value).toContain("outline-none");
  const field = classesOf(out, "div", "copy-field");
  for (const c of ring) expect(field).toContain(c);
});

test("a caller's className keeps the focus ring", () => {
  const out = renderToStaticMarkup(<CopyField value="ABCD-1234" className="w-44 text-base tracking-widest" />);
  const field = classesOf(out, "div", "copy-field");
  for (const c of ring) expect(field).toContain(c);
  expect(field).toContain("w-44");
});

// The eye button keeps its own focus ring, so it must not also ring the field.
test("only the value button rings the field, not the eye button", () => {
  const out = renderToStaticMarkup(<CopyField value="secret" secret aria-label="Token" />);
  const field = classesOf(out, "div", "copy-field");
  expect(field.some((c) => c.startsWith("has-[:focus-visible]") || c.startsWith("focus-within"))).toBe(false);
  expect(out.match(/data-slot="copy-field-value"/g)?.length).toBe(1);
});

// Commands and links wrap instead of ending in "...": the join command's
// token and the invite link were cut off, so people pasted what they could
// not read. The buttons stay on the first line.
test("a long value wraps instead of being cut off", () => {
  const out = renderToStaticMarkup(<CopyField value={`curl -fsSL https://install.example.dev | sh -s -- --token ${"x".repeat(80)}`} />);
  const value = classesOf(out, "button", "copy-field-value");
  expect(value).not.toContain("truncate");
  expect(value).toContain("whitespace-pre-wrap");
  expect(value).toContain("[overflow-wrap:anywhere]");
  const field = classesOf(out, "div", "copy-field");
  expect(field).toContain("min-h-[38px]");
  expect(field).toContain("items-start");
  expect(field).not.toContain("h-[38px]");
});
