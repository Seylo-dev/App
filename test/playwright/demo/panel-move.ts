// Moving the panel (0.2.8) with the demo panel's nodes: de-fsn-1 runs the
// panel, us-ash-1 can take it, il-tlv-1 runs an older agent. panelMove.status
// and panelMove.check answers for the demo world and for panel-move.spec.ts,
// which builds the card's states from them.

import { ids } from "./fixtures";

type Input = Record<string, any>;

export const moveNodes = {
  de: { id: ids.de, name: "de-fsn-1" },
  us: { id: ids.us, name: "us-ash-1" },
  il: { id: ids.il, name: "il-tlv-1" },
} as const;

/** panelMove.status with nothing moving. */
export function moveStatus(over: Input = {}): Input {
  return {
    state: "idle",
    side: null,
    moveId: null,
    targetNodeId: null,
    targetNodeName: null,
    targetAddress: null,
    newUrl: null,
    step: null,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: null,
    error: null,
    leftBehind: [],
    doneAt: null,
    fromNodeId: null,
    fromNodeName: null,
    oldCopyRemoved: false,
    domain: null,
    canCancel: false,
    oldPanelRunning: false,
    ...over,
  };
}

/** A move from de-fsn-1 to us-ash-1, running, at `step`. */
export function movingStatus(over: Input = {}): Input {
  return moveStatus({
    state: "running",
    moveId: "move000000000001",
    targetNodeId: ids.us,
    targetNodeName: "us-ash-1",
    targetAddress: "198.51.100.7",
    newUrl: "http://198.51.100.7:3000",
    fromNodeId: ids.de,
    fromNodeName: "de-fsn-1",
    startedAt: new Date(Date.now() - 40_000).toISOString(),
    step: "shipping",
    bytesDone: 18 * 1024 * 1024,
    bytesTotal: 46 * 1024 * 1024,
    canCancel: true,
    ...over,
  });
}

const targets = () => [
  {
    ...moveNodes.de,
    online: true,
    address: "203.0.113.10",
    ready: false,
    blocks: [{ code: "targetIsPanel", message: "The panel runs on de-fsn-1 already.", nodeIds: [ids.de], soft: false }],
  },
  {
    ...moveNodes.il,
    online: true,
    address: "192.0.2.44",
    ready: false,
    blocks: [
      {
        code: "targetTooOld",
        message: "il-tlv-1 runs agent 0.9.3, the panel 0.9.4. Update it in Settings > Updates first.",
        nodeIds: [ids.il],
        soft: false,
      },
    ],
  },
  { ...moveNodes.us, online: true, address: "198.51.100.7", ready: true, blocks: [] },
];

/** panelMove.check for the demo panel: nothing refuses a move to us-ash-1. */
export function moveCheck(input: Input = {}, over: Input = {}): Input {
  const picked = typeof input.targetNodeId === "string" ? input.targetNodeId : null;
  const target = targets().find((node) => node.id === picked);
  return {
    blocks: target ? target.blocks : [],
    targets: targets(),
    targetNodeId: picked,
    defaultAddress: target?.address ?? null,
    nodesToMove: target ? [moveNodes.de, moveNodes.il, moveNodes.us] : [],
    nodesLeftBehind: [],
    warnings: target
      ? [
          {
            code: "domainDns",
            message: `Point the DNS record of panel.acme.dev at ${target.address} once the move finished. Nodes that connect over the domain use the new address until then, and the domain works again once its record points there.`,
          },
        ]
      : [],
    domain: "panel.acme.dev",
    agentPort: 3443,
    fromNode: moveNodes.de,
    ...over,
  };
}
