import { describe, expect, test } from "bun:test";
import { ToastStore } from "./toast-store";

describe("ToastStore", () => {
  test("shows, replaces by id, dismisses", () => {
    const s = new ToastStore();
    let emits = 0;
    s.subscribe(() => emits++);
    const id = s.show("Deploying", { id: "deploy" });
    expect(id).toBe("deploy");
    s.show("Deployed", { id: "deploy", tone: "success" });
    expect(s.getSnapshot()).toHaveLength(1);
    expect(s.getSnapshot()[0]?.title).toBe("Deployed");
    expect(s.getSnapshot()[0]?.tone).toBe("success");
    s.dismiss("deploy");
    expect(s.getSnapshot()).toHaveLength(0);
    expect(emits).toBe(3);
  });

  test("errors stay longer and the stack is capped at 5", () => {
    const s = new ToastStore();
    s.show("x", { tone: "error" });
    expect(s.getSnapshot()[0]?.duration).toBe(8000);
    for (let i = 0; i < 7; i++) s.show(`t${i}`);
    expect(s.getSnapshot()).toHaveLength(5);
    expect(s.getSnapshot()[4]?.title).toBe("t6");
  });

  test("snapshot identity only changes on change", () => {
    const s = new ToastStore();
    const a = s.getSnapshot();
    expect(s.getSnapshot()).toBe(a);
    s.show("y");
    expect(s.getSnapshot()).not.toBe(a);
  });
});
