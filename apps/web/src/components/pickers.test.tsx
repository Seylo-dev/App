import { expect, test } from "bun:test";
import { nodes, OpError } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { OpClientProvider, opQueryKey } from "@seylo/ops/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../i18n/t";
import { NodePicker } from "./pickers";

const forbidden = "You do not have the nodes.view permission here.";

// A member who may create services: nodes.list refuses them, nodes.choices answers.
function renderForMember() {
  // retryOnMount false: the refused nodes.list stays an error instead of refetching.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: opQueryKey(nodes.list, {}) })
    .setState({ status: "error", fetchStatus: "idle", error: new OpError("FORBIDDEN", forbidden, { action: "nodes.view" }) });
  queryClient.setQueryData(opQueryKey(nodes.choices, {}), {
    nodes: [{ id: "nod1nod1nod1nod1", name: "edge", status: "online", wildcardDomain: null, arch: "amd64" }],
  });
  // No request leaves the test: the answers are in the cache already.
  const client = { call: () => new Promise(() => {}) } as unknown as OpClient;
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpClientProvider client={client}>
        <NodePicker id="node" value="" onChange={() => {}} />
      </OpClientProvider>
    </QueryClientProvider>,
  );
}

test("the node picker works for members who cannot read nodes.list", () => {
  const out = renderForMember();
  expect(out).not.toContain(forbidden);
  expect(out).not.toContain(t("common.loading"));
  // The select is usable: it has a node to offer.
  expect(out).toContain('id="node"');
  expect(out).not.toContain("data-disabled");
});
