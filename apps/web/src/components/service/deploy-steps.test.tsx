import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWaitText, type Deployment, StepCards, StepChips, stripSteps } from "./deploy-steps";

const de = { id: "n000000000000001", name: "de-fsn-1" };

/** A building deploy as the panel answers it: its clone step runs from the dispatch. */
const steps = [
  { key: "clone", status: "running", node: de, detail: "Waiting for a build slot on de-fsn-1 - 1 ahead", durationMs: 40_000 },
  { key: "build", status: "pending", node: de, detail: "", durationMs: null },
  { key: "ship", status: "pending", node: null, detail: "", durationMs: null },
  { key: "health", status: "pending", node: null, detail: "", durationMs: null },
  { key: "switch", status: "pending", node: null, detail: "", durationMs: null },
] as Deployment["steps"];

describe("stripSteps", () => {
  test("a build waiting for a slot gets a pending Queued step first, and Clone waits behind it", () => {
    const strip = stripSteps(steps, { node: de, position: 2 });
    expect(strip.map((s) => [s.key, s.status, s.name])).toEqual([
      ["queued", "pending", "Queued"],
      ["clone", "pending", "Clone"],
      ["build", "pending", "Build on de-fsn-1"],
      ["ship", "pending", "Ship"],
      ["health", "pending", "Health check"],
      ["switch", "pending", "Switch traffic"],
    ]);
    // The place in line, and the time waited so far (the clone step's, which runs from the dispatch).
    expect(strip[0]).toMatchObject({ detail: "Waiting for a build slot on de-fsn-1 - 1 ahead", durationMs: 40_000 });
    expect(strip[1]).toMatchObject({ detail: "", durationMs: null });
  });

  test("without buildWait the strip is the deploy's five steps, Clone running", () => {
    expect(stripSteps(steps, null).map((s) => [s.key, s.status])).toEqual([
      ["clone", "running"],
      ["build", "pending"],
      ["ship", "pending"],
      ["health", "pending"],
      ["switch", "pending"],
    ]);
    expect(stripSteps(steps).length).toBe(5);
  });

  test("the place in line in words", () => {
    expect(buildWaitText({ node: de, position: 1 })).toBe("Waiting for a build slot on de-fsn-1 - next in line");
    expect(buildWaitText({ node: de, position: 4 })).toBe("Waiting for a build slot on de-fsn-1 - 3 ahead");
  });
});

test("the chips show Queued with a clock and its place in line as the title, no spinner", () => {
  const html = renderToStaticMarkup(<StepChips steps={steps} buildWait={{ node: de, position: 1 }} />);
  expect(html.indexOf(">Queued<")).toBeLessThan(html.indexOf(">Clone<"));
  expect(html).toContain('title="Waiting for a build slot on de-fsn-1 - next in line"');
  expect(html).toContain("tabler-icon-clock");
  expect(html).not.toContain("animate-spin");
  // Once it starts: Clone spins, no Queued step.
  const started = renderToStaticMarkup(<StepChips steps={steps} buildWait={null} />);
  expect(started).not.toContain(">Queued<");
  expect(started).toContain("animate-spin");
});

test("the log modal's cards put the place in line on the Queued card", () => {
  const html = renderToStaticMarkup(<StepCards steps={steps} buildWait={{ node: de, position: 3 }} />);
  expect(html.indexOf(">Queued<")).toBeLessThan(html.indexOf(">Clone<"));
  expect(html.match(/Waiting for a build slot on de-fsn-1 - 2 ahead/g)).toHaveLength(1);
  expect(html).toContain(">40s<");
  expect(html).not.toContain("animate-spin");
});
