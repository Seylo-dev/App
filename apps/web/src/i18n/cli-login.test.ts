import { expect, test } from "bun:test";
import { t } from "./t";

// The approval page says where the new key shows up; that is the settings
// section's own label, not a shortened one.
test("the key note names the settings section the key is listed in", () => {
  expect(t("cliLogin.keyNote", { client: "laptop" })).toContain(`Settings > ${t("settings.sections.apiKeys")},`);
});
