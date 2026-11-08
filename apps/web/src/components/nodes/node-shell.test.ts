import { expect, test } from "bun:test";
import { t } from "../../i18n/t";
import { prefillText } from "./node-shell";

const on = { enabled: true, available: true, canOpen: true, canEnable: true };

test("the prefill note names why no shell types the command here", () => {
  expect(t(prefillText(on))).toBe("The shell opens with this command typed in. Check it, then press Enter to run it.");
  // Allowed, but the node is offline or its agent too old: asking to allow them again would be wrong.
  expect(t(prefillText({ ...on, available: false }))).toBe("No shell can open on this node right now. Run it over SSH:");
  expect(t(prefillText({ ...on, canOpen: false, canEnable: false }))).toBe("Your role cannot open host shells. Run it over SSH:");
  expect(t(prefillText({ ...on, enabled: false, canOpen: false }))).toBe(
    "Allow host shells to type it into a shell here, or run it over SSH:",
  );
  expect(t(prefillText({ ...on, enabled: false, canOpen: false, canEnable: false }))).toBe(
    "Run it over SSH, or ask the owner to allow host shells here:",
  );
});
