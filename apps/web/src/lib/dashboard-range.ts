// What the dashboard's Nodes card shows: Live (the last 5 minutes as they
// happen, the default) or one of the stored ranges. Each person's last
// choice is remembered in this browser (localStorage, every access in
// try/catch: a private window or blocked storage just starts on Live).

import { slug } from "@seylo/brand";
import { useState } from "react";

export const nodeRanges = ["1h", "24h", "7d"] as const;
export type NodeRange = (typeof nodeRanges)[number];
export type NodeRangeChoice = "live" | NodeRange;

export const nodeRangeStorage = `${slug}.dashboard.nodesRange`;

type RangeStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): RangeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const choices: readonly string[] = ["live", ...nodeRanges];

export function readNodeRange(storage: RangeStorage | null = browserStorage()): NodeRangeChoice {
  try {
    const saved = storage?.getItem(nodeRangeStorage);
    return saved && choices.includes(saved) ? (saved as NodeRangeChoice) : "live";
  } catch {
    return "live";
  }
}

export function saveNodeRange(choice: NodeRangeChoice, storage: RangeStorage | null = browserStorage()): void {
  try {
    storage?.setItem(nodeRangeStorage, choice);
  } catch {
    // Storage blocked: the choice holds until the page is left.
  }
}

/** The card's choice, read once and saved on every change. */
export function useNodeRange(): [NodeRangeChoice, (choice: NodeRangeChoice) => void] {
  const [choice, setChoice] = useState<NodeRangeChoice>(() => readNodeRange());
  return [
    choice,
    (next) => {
      setChoice(next);
      saveNodeRange(next);
    },
  ];
}
