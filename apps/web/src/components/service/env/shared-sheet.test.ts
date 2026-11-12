// The shared variables sheet cannot hold references (env.setShared refuses
// them), so the hints that suggest writing one stay out of its editor: the
// "Use double quotes" fix would turn a template into a refused save.

import { expect, test } from "bun:test";
import { analyzeEnv } from "@seylo/env-analyzer";
import { sharedContext } from "./shared-sheet";

test("no reference hints in the shared variables sheet, syntax problems still", () => {
  const text = ["TPL='Hello ${{user.NAME}}'", "X=api.URL", "Y=project.URL", ""].join("\n");
  expect(analyzeEnv(text, sharedContext).diagnostics).toEqual([]);
  expect(analyzeEnv("TPL='Hello\n", sharedContext).diagnostics.map((d) => d.code)).toEqual(["unterminated-quote"]);
});
