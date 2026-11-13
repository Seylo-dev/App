// The run items of a service's menu on a list row come from the row's
// status, not from a services.get cached when the service's page was open
// (it is not refetched off the page, so after a stop or start from a list
// it is out of date); on its own page the live services.get decides.

import { expect, test } from "bun:test";
import { services } from "@seylo/ops";
import { entryIds } from "@seylo/ui/components/menu-items";
import { renderStatic } from "../../test/render";
import { ObjectActionsProvider } from "./object-actions";
import type { ServiceMenuSubject } from "./service-items";
import { useServiceMenu } from "./service-menu";

const api: ServiceMenuSubject = {
  id: "svcapi000000002a",
  projectId: "projacmeshop0001",
  name: "api",
  kind: "app",
  parentId: null,
  status: "running",
  address: "api.example.com",
  protected: false,
  placements: [{ nodeId: "nodedefsn1000001", nodeName: "de-fsn-1", replicas: 1 }],
};

function Probe({ service }: { service: ServiceMenuSubject }) {
  return <output>{entryIds(useServiceMenu(service)).join(" ")}</output>;
}

async function runItems(service: ServiceMenuSubject, cachedStopped: boolean, path = "/"): Promise<string[]> {
  const out = await renderStatic(
    () => (
      <ObjectActionsProvider>
        <Probe service={service} />
      </ObjectActionsProvider>
    ),
    [[services.get, { serviceId: service.id }, { ...service, stopped: cachedStopped }]],
    { path },
  );
  const ids = (/<output>([^<]*)<\/output>/.exec(out)?.[1] ?? "").split(" ");
  return ids.filter((id) => id === "restart" || id === "stop" || id === "start");
}

test("a row stopped from a list since its page was open: Start, not the cached Restart and Stop", async () => {
  expect(await runItems({ ...api, status: "stopped" }, false)).toEqual(["start"]);
});

test("a row started from a list since its page was open: Restart and Stop, not the cached Start", async () => {
  expect(await runItems({ ...api, status: "running" }, true)).toEqual(["restart", "stop"]);
});

test("on its own page the live services.get decides (a stopped clone that never ran shows Start)", async () => {
  const page = `/p/${api.projectId}/s/${api.id}`;
  expect(await runItems({ ...api, status: "idle" }, true, page)).toEqual(["start"]);
  // The same row anywhere else has nothing to start or stop yet.
  expect(await runItems({ ...api, status: "idle" }, true)).toEqual([]);
});
