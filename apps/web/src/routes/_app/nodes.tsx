// Nodes (Nodes.dc.html): the update strip, the node table and "Add a
// node". A node opens in a side sheet (?node=<id>&view=overview|health|
// cleanup|shell|settings); ?add=true starts the add flow (from the palette and the
// dashboard's empty state).

import { Button } from "@seylo/ui/components/button";
import { IconPlus } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AddNodeCard, type AddNodeHandle } from "../../components/nodes/add-node";
import { NodeSheet, type NodeView } from "../../components/nodes/node-sheet";
import { NodeTable } from "../../components/nodes/node-table";
import { UpdatesBanner } from "../../components/nodes/updates-banner";
import { PageHeader } from "../../components/page-header";
import { t } from "../../i18n/t";

const views: readonly NodeView[] = ["overview", "health", "cleanup", "shell", "settings"];

interface NodesSearch {
  node?: string;
  view?: NodeView;
  add?: boolean;
}

export const Route = createFileRoute("/_app/nodes")({
  validateSearch: (search: Record<string, unknown>): NodesSearch => ({
    node: typeof search.node === "string" && /^[a-z0-9]{16}$/.test(search.node) ? search.node : undefined,
    view: views.includes(search.view as NodeView) ? (search.view as NodeView) : undefined,
    add: search.add === true || search.add === "true" ? true : undefined,
  }),
  component: NodesPage,
});

function NodesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const addCard = useRef<AddNodeHandle>(null);

  useEffect(() => {
    if (!search.add) return;
    addCard.current?.start();
    void navigate({ search: (prev) => ({ ...prev, add: undefined }), replace: true });
  }, [search.add, navigate]);

  const openNode = (node: string, view: NodeView) => void navigate({ search: { node, view: view === "overview" ? undefined : view } });

  return (
    <>
      <PageHeader
        title={t("nav.nodes")}
        subtitle={t("nodes.subtitle")}
        actions={
          <Button variant="primary" onClick={() => addCard.current?.start()}>
            <IconPlus size={15} stroke={2.2} aria-hidden="true" />
            {t("nodes.addNode")}
          </Button>
        }
      />
      <UpdatesBanner />
      <NodeTable onOpen={openNode} />
      <AddNodeCard ref={addCard} />
      <NodeSheet
        nodeId={search.node ?? null}
        view={search.view ?? "overview"}
        onViewChange={(view) => void navigate({ search: (prev) => ({ ...prev, view: view === "overview" ? undefined : view }) })}
        onClose={() => void navigate({ search: {} })}
      />
    </>
  );
}
