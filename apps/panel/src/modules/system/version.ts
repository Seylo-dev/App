import { system } from "@seylo/ops";
import { implement } from "../../ops/implement";

export const version = implement(system.version, (_input, ctx) => ({
  version: ctx.config.version,
  protocol: "v1",
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  startedAt: ctx.startedAt.toISOString(),
  uptimeSeconds: Math.max(0, Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000)),
}));
