import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { logoSource, TemplateLogo } from "./template-logo";

test("a logo shows as an image on the neutral tile, named for the app", () => {
  const markup = renderToStaticMarkup(<TemplateLogo slug="grafana" name="Grafana" logoUrl="/api/templates/grafana/logo.svg" />);
  expect(markup).toContain('<img src="/api/templates/grafana/logo.svg" alt="Grafana"');
  expect(markup).toContain("object-contain");
  expect(markup).toContain("bg-logo-tile");
  expect(markup).toContain("width:36px;height:36px");
  expect(markup).not.toContain("bg-chip-");
});

test("without a logo it is the letter tile, the same size", () => {
  const markup = renderToStaticMarkup(<TemplateLogo slug="appsmith" name="Appsmith" logoUrl={null} />);
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("bg-logo-tile");
  expect(markup).toMatch(/bg-chip-[a-z]+-bg/);
  expect(markup).toContain("width:36px;height:36px");
  expect(markup).toContain(">A</span>");
});

test("a logo that fails to load falls back to the letter tile until the URL changes", () => {
  expect(logoSource("/api/templates/grafana/logo.svg", null)).toBe("/api/templates/grafana/logo.svg");
  expect(logoSource("/api/templates/grafana/logo.svg", "/api/templates/grafana/logo.svg")).toBeNull();
  expect(logoSource("/api/templates/gitea/logo.svg", "/api/templates/grafana/logo.svg")).toBe("/api/templates/gitea/logo.svg");
  expect(logoSource(null, null)).toBeNull();
});
