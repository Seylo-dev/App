import { expect, test } from "bun:test";
import type { Project, ServiceStatus, ServiceSummary } from "../../lib/types";
import { ariaSort, nextServiceSort, type ServiceTableRow, sortServiceRows } from "./service-sort";

const project = (id: string, name: string) => ({ id, name }) as Project;
const shop = project("p1", "shop");
const blog = project("p2", "blog");

function row(
  name: string,
  owner: Project,
  projectIndex: number,
  extra: { status?: ServiceStatus; cpu?: number | null; memory?: number | null; deployed?: string | null; node?: string } = {},
): ServiceTableRow {
  const service = {
    id: `${owner.id}-${name}`,
    name,
    projectId: owner.id,
    status: extra.status ?? "running",
    cpuPercent: extra.cpu ?? null,
    memoryBytes: extra.memory ?? null,
    lastDeployedAt: extra.deployed ?? null,
    placements: extra.node ? [{ nodeId: extra.node, nodeName: extra.node, replicas: 1 }] : [],
  } as unknown as ServiceSummary;
  return { service, project: owner, projectIndex };
}

const names = (rows: ServiceTableRow[]) => rows.map((r) => `${r.project.name}/${r.service.name}`);

// The dashboard lists shop first (the person's order), then blog.
const rows = [
  row("worker", shop, 0, { status: "building", deployed: null, node: "us-ash-1" }),
  row("web", blog, 1, { cpu: 1, memory: 64, deployed: "2026-11-09T10:00:00Z", node: "us-ash-1" }),
  row("api", shop, 0, { cpu: 7, memory: 241, deployed: "2026-11-10T08:00:00Z", node: "de-fsn-1" }),
  row("web10", shop, 0, { cpu: 4, memory: 182, deployed: "2026-11-10T06:00:00Z", node: "de-fsn-1" }),
  row("web2", shop, 0, { status: "crashed", cpu: null, memory: null, deployed: "2026-11-01T00:00:00Z", node: "de-fsn-1" }),
];

test("unsorted, the table follows the projects' order, then the service names (numbers in names count as numbers)", () => {
  expect(names(sortServiceRows(rows, null))).toEqual(["shop/api", "shop/web2", "shop/web10", "shop/worker", "blog/web"]);
  // A copy: the rows passed in keep their order.
  expect(rows[0]?.service.name).toBe("worker");
});

test("CPU sorts busiest first, then quietest first; services that do not run go last both ways", () => {
  const first = nextServiceSort(null, "cpu");
  expect(first).toEqual({ column: "cpu", desc: true });
  expect(names(sortServiceRows(rows, first))).toEqual(["shop/api", "shop/web10", "blog/web", "shop/web2", "shop/worker"]);
  const second = nextServiceSort(first, "cpu");
  expect(second).toEqual({ column: "cpu", desc: false });
  // web2 and worker have no CPU: they keep the project and name order at the end.
  expect(names(sortServiceRows(rows, second))).toEqual(["blog/web", "shop/web10", "shop/api", "shop/web2", "shop/worker"]);
  // The third click goes back to project and name.
  expect(nextServiceSort(second, "cpu")).toBeNull();
});

test("words sort from A on the first click; another column starts over", () => {
  const byName = nextServiceSort(null, "service");
  expect(byName).toEqual({ column: "service", desc: false });
  // Two services named alike keep the project order.
  expect(names(sortServiceRows(rows, byName))).toEqual(["shop/api", "blog/web", "shop/web2", "shop/web10", "shop/worker"]);
  expect(nextServiceSort(byName, "service")).toEqual({ column: "service", desc: true });
  expect(nextServiceSort({ column: "service", desc: true }, "memory")).toEqual({ column: "memory", desc: true });
  expect(names(sortServiceRows(rows, { column: "project", desc: false }))).toEqual([
    "blog/web",
    "shop/api",
    "shop/web2",
    "shop/web10",
    "shop/worker",
  ]);
  expect(names(sortServiceRows(rows, { column: "node", desc: false }))).toEqual([
    "shop/api",
    "shop/web2",
    "shop/web10",
    "shop/worker",
    "blog/web",
  ]);
});

test("status puts problems first, then work in progress, then what runs", () => {
  const sorted = sortServiceRows(rows, nextServiceSort(null, "status"));
  expect(sorted.map((r) => r.service.status)).toEqual(["crashed", "building", "running", "running", "running"]);
});

test("last deploy sorts newest first; never deployed goes last", () => {
  expect(names(sortServiceRows(rows, nextServiceSort(null, "deployed")))).toEqual([
    "shop/api",
    "shop/web10",
    "blog/web",
    "shop/web2",
    "shop/worker",
  ]);
});

test("aria-sort names the sorted column's direction and none elsewhere", () => {
  expect(ariaSort(null, "cpu")).toBe("none");
  expect(ariaSort({ column: "cpu", desc: true }, "cpu")).toBe("descending");
  expect(ariaSort({ column: "cpu", desc: false }, "cpu")).toBe("ascending");
  expect(ariaSort({ column: "cpu", desc: false }, "memory")).toBe("none");
});
