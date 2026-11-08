import { expect, test } from "bun:test";
import { services, updates } from "@seylo/ops";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { ParentCrumb } from "../service/parent-crumb";
import { NodesCard } from "./nodes-card";

const updateStatus = {
  autoUpdate: true,
  panel: { updateAvailable: false },
  nodes: [{ nodeId: "n1", name: "de-1", online: true, version: "0.2.0", updateAvailable: false }],
  activeRun: null,
};

test("the sidebar nodes card shows placeholders, not '0 nodes online' and 'not available yet', while it loads", async () => {
  const out = await renderStatic(() => <NodesCard online={undefined} total={undefined} loading />);
  expect(out).not.toContain(t("sidebar.nodesOnline", { count: 0 }));
  expect(out).not.toContain(t("common.notAvailableYet"));
  // The count line and the two update lines.
  expect(out.split('data-slot="skeleton"').length - 1).toBe(3);
  expect(out).toContain('aria-busy="true"');
});

test("the nodes card shows the real values once system.info and updates.status answer", async () => {
  const out = await renderStatic(() => <NodesCard online={2} total={3} />, [[updates.status, {}, updateStatus]]);
  expect(out).toContain(t("sidebar.nodesOnline", { count: 2 }));
  expect(out).toContain(t("sidebar.autoUpdateOn"));
  expect(out).toContain(t("sidebar.upToDate"));
  expect(out).not.toContain('data-slot="skeleton"');
  expect(out).not.toContain("aria-busy");
});

test("a compose member's breadcrumb shows a placeholder for its stack, not the stack's id, until services.get answers", async () => {
  const pending = await renderStatic(() => <ParentCrumb projectId="prj1" parentId="svcstack00000001" />);
  expect(pending).not.toContain(">svcstack00000001<");
  expect(pending).toContain('data-slot="skeleton"');

  const loaded = await renderStatic(
    () => <ParentCrumb projectId="prj1" parentId="svcstack00000001" />,
    [[services.get, { serviceId: "svcstack00000001" }, { id: "svcstack00000001", name: "monitoring" }]],
  );
  expect(loaded).toContain(">monitoring<");
  expect(loaded).not.toContain('data-slot="skeleton"');
});
