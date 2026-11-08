// Settings keys of the tailscale module, declared by augmenting
// SettingValues (src/settings.ts). Nothing here is a secret: the server's
// tailnet name and MagicDNS name, and what the panel last heard. The
// sign-in link is never stored (sign-in.ts).

import type { tailscale } from "@seylo/ops";
import type { PanelDb } from "../../db/client";
import { getSetting } from "../../settings";

/** What the panel last heard from its own node about Tailscale, plus the tailnet path's debounce. */
export interface TailscaleSeen {
  /** The agent found tailscaled's socket. */
  detected: boolean;
  /** tailscaled's BackendState ("Running", "NeedsLogin", ...); empty when not detected. */
  state: string;
  dnsName: string;
  tailnet: string;
  https: boolean;
  serveState: tailscale.TailscaleServeState;
  /** Where Serve answers ("https://<dnsName>"); empty unless active. */
  url: string;
  panelAnswers: boolean;
  /** Key expiry, epoch ms; null when disabled or unknown. */
  keyExpiry: number | null;
  /** The last report on its own: Serve wanted, Running, Serve active and the panel answered through it. */
  reported: boolean;
  /** After the debounce: what the tailnet path counts as (private-path.ts). */
  working: boolean;
  /** When `working` last became true, epoch ms; null while it is not working. */
  workingSince: number | null;
  /** When `working` last became false, epoch ms; null when it never stopped. */
  stoppedAt: number | null;
  /** The first explicit non-working report while working (the 5-minute debounce); null otherwise. */
  downSince: number | null;
  /** When the panel recorded the last report, epoch ms. */
  checkedAt: number;
}

declare module "../../settings" {
  interface SettingValues {
    /** "Serve the panel on my tailnet"; absent means false. */
    tailscaleServe: boolean;
    tailscaleSeen: TailscaleSeen;
  }
}

export const emptySeen: TailscaleSeen = {
  detected: false,
  state: "",
  dnsName: "",
  tailnet: "",
  https: false,
  serveState: "off",
  url: "",
  panelAnswers: false,
  keyExpiry: null,
  reported: false,
  working: false,
  workingSince: null,
  stoppedAt: null,
  downSince: null,
  checkedAt: 0,
};

export function readServeWanted(db: PanelDb): boolean {
  return getSetting(db, "tailscaleServe") ?? false;
}

export function readSeen(db: PanelDb): TailscaleSeen {
  return { ...emptySeen, ...getSetting(db, "tailscaleSeen") };
}
