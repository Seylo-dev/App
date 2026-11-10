import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, initials } from "./avatar";

test("initials come from a name or the part of an email before the @", () => {
  expect(initials("Dana Levi")).toBe("DL");
  expect(initials("ops@example.com")).toBe("OP");
  expect(initials("build-bot")).toBe("BB");
});

test("without an image it shows the initials, named for screen readers", () => {
  const out = renderToStaticMarkup(<Avatar name="Dana Levi" />);
  expect(out).toContain('aria-label="Dana Levi"');
  expect(out).toContain(">DL<");
});

test("decorative avatars sit next to the written name and stay out of the accessibility tree", () => {
  const out = renderToStaticMarkup(<Avatar name="Dana Levi" decorative />);
  expect(out).toContain('aria-hidden="true"');
  expect(out).not.toContain("aria-label");
});

test("with an image the initials wait, so a cached avatar never flashes them", () => {
  // The image renders once it has loaded in the browser; before that the root alone holds the place.
  const out = renderToStaticMarkup(<Avatar name="Dana Levi" src="/api/avatars/notionists/dana.svg" size="xl" />);
  expect(out).not.toContain(">DL<");
  expect(out).toContain("size-20");
});
