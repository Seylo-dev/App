import { expect, test } from "bun:test";
import { connectedNote } from "./console-pages";

test("the connected note leaves out what an older agent did not send", () => {
  expect(connectedNote("api", { generation: 4, user: "bun", workdir: "/app" }, "30 min")).toBe(
    "Connected to api (generation 4) as bun in /app · ends after 30 min idle",
  );
  expect(connectedNote("api", { generation: 4, user: "", workdir: "" }, "30 min")).toBe(
    "Connected to api (generation 4) · ends after 30 min idle",
  );
});
