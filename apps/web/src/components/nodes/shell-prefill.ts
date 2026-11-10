// The commands ?prefill= may type in a node's Shell view, by name. Nothing
// else is ever typed for the person. Its own module: the nodes route checks
// the search with it, and importing node-shell.tsx there put the terminal
// (xterm) in the app's first bundle.

import { tailscale } from "@seylo/ops";

export const shellPrefills = {
  "tailscale-install": tailscale.tailscaleInstallCommand,
} as const;
export type ShellPrefill = keyof typeof shellPrefills;

export function isShellPrefill(value: unknown): value is ShellPrefill {
  return typeof value === "string" && Object.hasOwn(shellPrefills, value);
}
