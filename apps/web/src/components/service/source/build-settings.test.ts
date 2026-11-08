import { expect, test } from "bun:test";
import { nodeUnavailable, settingsInput } from "./build-settings";

const fields = {
  builder: "railpack" as const,
  contextPath: ".",
  dockerfilePath: "Dockerfile",
  installCommand: "",
  buildCommand: "bun run build",
  startCommand: "",
  targetStage: "",
};

test("Save sends the build node only when it changed", () => {
  // Pinned to a node that lost docker buildx since: saving a new build command must not send (and fail on) it.
  const kept = settingsInput("svc0000000000001", "node00000000000a", "node00000000000a", fields, false);
  expect(kept).toEqual({ serviceId: "svc0000000000001", ...fields });
  expect("buildNodeId" in kept).toBe(false);

  expect(settingsInput("svc0000000000001", "node00000000000a", null, fields, false).buildNodeId).toBeNull();
  expect(settingsInput("svc0000000000001", null, "node00000000000b", fields, false).buildNodeId).toBe("node00000000000b");
  expect(settingsInput("svc0000000000001", null, null, fields, true)).toEqual({ serviceId: "svc0000000000001", targetStage: "" });
});

test("the picker offers no node the panel would refuse, and says why", () => {
  const node = { id: "node00000000000a", name: "de-fsn-1", canBuild: true, online: true, hasBuildx: true, queued: 0 };
  expect(nodeUnavailable(node)).toBeNull();
  expect(nodeUnavailable({ ...node, hasBuildx: false })).toBe("serviceSource.build.noBuildx");
  expect(nodeUnavailable({ ...node, canBuild: false, hasBuildx: false })).toBe("serviceSource.build.cantBuild");
  expect(nodeUnavailable({ ...node, online: false })).toBe("serviceSource.build.offline");
});
