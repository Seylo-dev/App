import { describe, expect, test } from "bun:test";
import { defaultCheckText, imageCheckCommand } from "./default-check";

const respo = { test: ["CMD-SHELL", "bun run healthcheck"], intervalSeconds: 10, timeoutSeconds: 5, startPeriodSeconds: 600, retries: 3 };

describe("the default health check line", () => {
  test("names the image's HEALTHCHECK when the node reported one", () => {
    expect(defaultCheckText({ imageHealthCheck: respo, ports: [{ containerPort: 3000, protocol: "tcp" }] })).toBe(
      "Image HEALTHCHECK: bun run healthcheck, every 10s, start period 600s, 3 retries",
    );
    expect(
      defaultCheckText({
        imageHealthCheck: { ...respo, test: ["CMD", "curl", "-f", "localhost"], retries: 1, startPeriodSeconds: 0 },
        ports: [],
      }),
    ).toBe("Image HEALTHCHECK: curl -f localhost, every 10s, start period 0s, 1 retry");
  });

  test("is TCP on the first TCP port otherwise, or running without one", () => {
    const ports = [
      { containerPort: 53, protocol: "udp" as const },
      { containerPort: 8080, protocol: "tcp" as const },
    ];
    expect(defaultCheckText({ imageHealthCheck: null, ports })).toBe("TCP on port 8080");
    expect(defaultCheckText({ ports })).toBe("TCP on port 8080");
    expect(defaultCheckText({ imageHealthCheck: null, ports: [] })).toBe("Without ports the service counts as healthy once it is running.");
  });

  test("Docker's test forms", () => {
    expect(imageCheckCommand(["CMD-SHELL", "wget -qO- localhost"])).toBe("wget -qO- localhost");
    expect(imageCheckCommand(["CMD", "/bin/check", "--quiet"])).toBe("/bin/check --quiet");
    expect(imageCheckCommand(["check"])).toBe("check");
  });
});
