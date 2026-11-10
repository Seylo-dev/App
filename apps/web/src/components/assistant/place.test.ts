import { describe, expect, test } from "bun:test";
import { t } from "../../i18n/t";
import { contextOf, placeOf, suggestionsFor } from "./place";

const project = "prj0000000000001";
const service = "svc0000000000002";

// The chips of an empty chat come from where the person is (owner request:
// "Why did the last deploy fail?" on a service page), and a new chat
// starts with that page as its context.
describe("where the chat was opened", () => {
  test("a service page, any of its tabs", () => {
    for (const path of [`/p/${project}/s/${service}`, `/p/${project}/s/${service}/logs`, `/p/${project}/s/${service}/`]) {
      expect(placeOf(path)).toEqual({ kind: "service", projectId: project, serviceId: service });
    }
    const place = placeOf(`/p/${project}/s/${service}/deployments`);
    expect(contextOf(place)).toEqual({ projectId: project, serviceId: service });
    expect(suggestionsFor(place).map((key) => t(key))).toEqual([
      "Why did the last deploy fail?",
      "Show the last 50 log lines",
      "How much memory and CPU does it use?",
      "Restart it",
    ]);
  });

  test("a project page", () => {
    const place = placeOf(`/p/${project}`);
    expect(place).toEqual({ kind: "project", projectId: project });
    expect(contextOf(place)).toEqual({ projectId: project });
    expect(t(suggestionsFor(place)[0] ?? "assistant.name")).toBe("What runs in this project?");
  });

  test("nodes, approvals, activity and everything else", () => {
    expect(placeOf("/nodes").kind).toBe("nodes");
    expect(placeOf("/approvals").kind).toBe("approvals");
    expect(placeOf("/activity").kind).toBe("activity");
    for (const path of ["/", "/settings/ai", "/templates", "/p/not-an-id"]) expect(placeOf(path).kind).toBe("general");
    expect(contextOf(placeOf("/nodes"))).toEqual({});
    for (const kind of ["nodes", "approvals", "activity", "general"] as const) {
      const keys = suggestionsFor({ kind } as never);
      expect(keys.length).toBeGreaterThan(0);
      // Every chip has its words.
      for (const key of keys) expect(t(key)).not.toBe(key);
    }
  });
});
