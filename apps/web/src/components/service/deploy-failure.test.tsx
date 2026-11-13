// A failed deploy's own output and Use port (0.2.16): the output is a
// collapsed block of its own, never part of the error; Use port is offered
// for the ports the app listens on, only where services.usePort applies.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LastOutput, usePortChoices } from "./deploy-failure";
import type { Deployment } from "./deploy-steps";

const node = { id: "n000000000000001", name: "il-ra" };
const hint = { node, port: 80, listening: [6000], loopbackOnly: [9229], canUsePort: true };

test("Use port: the ports the app listens on, for a failed deploy of a service that can switch", () => {
  expect(usePortChoices({ status: "failed", portHint: hint })).toEqual([6000]);
  expect(usePortChoices({ status: "failed", portHint: { ...hint, canUsePort: false } })).toEqual([]);
  expect(usePortChoices({ status: "failed", portHint: { ...hint, listening: [] } })).toEqual([]);
  expect(usePortChoices({ status: "live", portHint: hint })).toEqual([]);
  expect(usePortChoices({ status: "failed", portHint: null })).toEqual([]);
  expect(usePortChoices({ status: "failed", portHint: { ...hint, listening: [3000, 4000, 5000, 6000] } })).toEqual([3000, 4000, 5000]);
});

test("the last output is a collapsed block apart from the error, with every line and the node", () => {
  const lines = ["[Cloudflare R2] Connected", "Server is running on port 6000", "Heartbeat"];
  const html = renderToStaticMarkup(<LastOutput d={{ lastOutput: { node, lines } } as Pick<Deployment, "lastOutput">} />);
  expect(html).toStartWith("<details");
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).toContain("Last output of the new container");
  expect(html).toContain("on il-ra");
  expect(html).toContain("3 lines");
  expect(html).toContain("Server is running on port 6000\nHeartbeat");
  expect(renderToStaticMarkup(<LastOutput d={{ lastOutput: null }} />)).toBe("");
  expect(renderToStaticMarkup(<LastOutput d={{ lastOutput: { node, lines: [] } }} />)).toBe("");
});
