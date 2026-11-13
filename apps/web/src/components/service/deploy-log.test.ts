import { describe, expect, test } from "bun:test";
import { deployments } from "@seylo/ops";
import { opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { applyDeployment, freshLines, nextSeq } from "./deploy-log";
import type { Deployment } from "./deploy-steps";

describe("applyDeployment", () => {
  const serviceId = "aaaaaaaaaaaaaaaa";
  const row = (generation: number, status: Deployment["status"]) =>
    ({ id: `d00000000000000${generation}`, serviceId, generation, status, live: status === "live" }) as Deployment;
  const listKey = (limit: number) => opQueryKey(deployments.list, { serviceId, limit });
  const list = (rows: Deployment[]) => ({ deployments: rows, nextCursor: null, keptImages: 0 });
  type List = ReturnType<typeof list>;
  /** The newest row of a cached list. */
  const top = (query: { state: { data: unknown } } | undefined) => (query?.state.data as List | undefined)?.deployments[0];

  test("a list without the deployment keeps its age and the invalidation that says it is out of date", async () => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    // The Overview's list (left for the Deployments tab: no observer) still ends in gen 2; gen 3 is new.
    cache.setQueryData(listKey(5), list([row(2, "failed"), row(1, "failed")]));
    // The Deployments tab's list holds gen 3, still building.
    cache.setQueryData(listKey(20), list([row(3, "building"), row(2, "failed"), row(1, "failed")]));
    const overview = () => cache.getQueryCache().find({ queryKey: listKey(5), exact: true });
    const history = () => cache.getQueryCache().find({ queryKey: listKey(20), exact: true });
    const before = overview()?.state.dataUpdatedAt;
    // service:<id> says deployments.list changed: the inactive Overview list is only marked.
    await cache.invalidateQueries({ queryKey: opQueryKey(deployments.list) });
    expect(overview()?.state.isInvalidated).toBe(true);

    // The deploy log's last tick: gen 3 is live.
    await Bun.sleep(5);
    applyDeployment(cache, row(3, "live"));
    // Before: the Overview's list was written too, unchanged, and became fresh and valid.
    expect(overview()?.state.isInvalidated).toBe(true);
    expect(overview()?.state.dataUpdatedAt).toBe(before as number);
    // The list that holds gen 3 shows it live, and keeps its own age and mark as well.
    expect(top(history())?.status).toBe("live");
    expect(history()?.state.isInvalidated).toBe(true);

    // Back on the Overview: its list is fetched again and shows gen 3.
    let fetched = 0;
    const observer = new QueryObserver(cache, {
      queryKey: listKey(5),
      queryFn: async () => {
        fetched++;
        return list([row(3, "live"), row(2, "failed"), row(1, "failed")]);
      },
      staleTime: 30_000,
    });
    const stop = observer.subscribe(() => {});
    await Bun.sleep(5);
    expect(fetched).toBe(1);
    expect(top(overview())?.generation).toBe(3);
    stop();
  });

  test("a fresh list that holds the deployment shows it at once and stays fresh", () => {
    const cache = new QueryClient();
    cache.setQueryData(listKey(5), list([row(3, "building")]));
    const query = () => cache.getQueryCache().find({ queryKey: listKey(5), exact: true });
    const at = query()?.state.dataUpdatedAt;
    applyDeployment(cache, row(3, "deploying"));
    expect(top(query())?.status).toBe("deploying");
    expect(query()?.state.isInvalidated).toBe(false);
    expect(query()?.state.dataUpdatedAt).toBe(at as number);
  });

  test("a deployments.get of another deployment is left alone", () => {
    const cache = new QueryClient();
    const key = opQueryKey(deployments.get, { serviceId, deploymentId: "d000000000000002" });
    cache.setQueryData(key, { deployment: row(2, "failed"), logTopic: "deployment:d000000000000002" });
    void cache.invalidateQueries({ queryKey: key, refetchType: "none" });
    applyDeployment(cache, row(3, "live"));
    expect(cache.getQueryCache().find({ queryKey: key, exact: true })?.state.isInvalidated).toBe(true);
  });
});

describe("freshLines", () => {
  test("drops lines a page already delivered", () => {
    const { fresh, gap } = freshLines(4, [{ seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }]);
    expect(fresh.map((l) => l.seq)).toEqual([5, 6]);
    expect(gap).toBe(false);
  });

  test("a jump past the next seq is a gap", () => {
    expect(freshLines(4, [{ seq: 7 }]).gap).toBe(true);
    expect(freshLines(-1, [{ seq: 0 }]).gap).toBe(false);
  });

  test("sorts out-of-order lines and ignores an all-old event", () => {
    expect(freshLines(0, [{ seq: 2 }, { seq: 1 }]).fresh.map((l) => l.seq)).toEqual([1, 2]);
    expect(freshLines(9, [{ seq: 3 }])).toEqual({ fresh: [], gap: false });
  });
});

test("nextSeq keeps the old seq on an empty page", () => {
  expect(nextSeq(5, [])).toBe(5);
  expect(nextSeq(5, [{ seq: 9 }, { seq: 7 }])).toBe(9);
});
