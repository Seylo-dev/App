import { describe, expect, test } from "bun:test";
import { allOps } from "@seylo/ops";
import { en } from "../../i18n/en/index.gen";
import { actionPhrase, isDestructive, isLookup } from "./phrases";

// The action cards say what happened in words ("Restarted api"), and an
// approval asks ("Restart api?"); ops without a phrase fall back to their
// own summary, so a new op never shows an id or a key.
describe("action card phrases", () => {
  test("common ops read as sentences in each phase", () => {
    expect(actionPhrase("services.restart", "ask", "api")).toBe("Restart api?");
    expect(actionPhrase("services.restart", "running", "api")).toBe("Restarting api");
    expect(actionPhrase("services.restart", "done", "api")).toBe("Restarted api");
    expect(actionPhrase("services.restart", "failed", "api")).toBe("Could not restart api");
    expect(actionPhrase("projects.list", "done", undefined)).toBe("Listed your projects");
  });

  test("without a phrase, or without the name a phrase needs, the op's summary", () => {
    expect(actionPhrase("builds.updateSettings", "ask", "api")).toBe("Change a service's build settings?");
    expect(actionPhrase("builds.updateSettings", "done", "api")).toBe("Change a service's build settings");
    expect(actionPhrase("services.restart", "ask", undefined)).toBe("Restart a service?");
    expect(actionPhrase("services.restart", "done", "")).toBe("Restart a service");
    expect(actionPhrase("nope.nothing", "done", undefined)).toBe("nope.nothing");
  });

  test("every phrase names a real op and has all four phases", () => {
    const ids = new Set(allOps.map((op) => op.id));
    for (const [module, actions] of Object.entries(en.assistant.actions)) {
      for (const [action, phases] of Object.entries(actions)) {
        expect(ids.has(`${module}.${action}`)).toBe(true);
        expect(Object.keys(phases).sort()).toEqual(["ask", "done", "failed", "running"]);
      }
    }
  });

  test("kinds come from the registry", () => {
    expect(isDestructive("projects.delete")).toBe(true);
    expect(isDestructive("services.restart")).toBe(false);
    expect(isLookup("logs.search")).toBe(true);
    expect(isLookup("services.restart")).toBe(false);
  });
});
