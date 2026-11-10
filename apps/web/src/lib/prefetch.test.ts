import { describe, expect, test } from "bun:test";
import { projects } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { opQueryKey } from "@seylo/ops/react";
import { QueryClient } from "@tanstack/react-query";
import { prefetchOp, startPrefetch } from "./prefetch";

function context(answer: (opId: string, input: unknown) => unknown) {
  const calls: { opId: string; input: unknown }[] = [];
  const opClient = {
    call: async (op: { id: string }, input: unknown) => {
      calls.push({ opId: op.id, input });
      const value = answer(op.id, input);
      if (value instanceof Error) throw value;
      return value;
    },
  } as unknown as OpClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
  return { ctx: { queryClient, opClient }, calls };
}

describe("prefetchOp", () => {
  test("fills the query the page reads, under the same key, once while fresh", async () => {
    const { ctx, calls } = context(() => ({ project: { id: "p1", name: "shop" } }));
    const value = await prefetchOp(ctx, projects.get, { projectId: "p1" });
    expect(value).toEqual({ project: { id: "p1", name: "shop" } } as never);
    expect(ctx.queryClient.getQueryData(opQueryKey(projects.get, { projectId: "p1" }))).toEqual(value);
    await prefetchOp(ctx, projects.get, { projectId: "p1" });
    expect(calls).toHaveLength(1);
  });

  test("a failed request resolves undefined and leaves nothing cached", async () => {
    const { ctx } = context(() => new Error("down"));
    expect(await prefetchOp(ctx, projects.get, { projectId: "p1" })).toBeUndefined();
    expect(ctx.queryClient.getQueryData(opQueryKey(projects.get, { projectId: "p1" }))).toBeUndefined();
  });
});

describe("startPrefetch", () => {
  test("swallows a throw and a rejection", async () => {
    expect(() =>
      startPrefetch(() => {
        throw new Error("sync");
      }),
    ).not.toThrow();
    startPrefetch(() => Promise.reject(new Error("async")));
    await Bun.sleep(0);
  });
});
