// The sidebar's main navigation, shared with the command palette.

import { IconActivity, IconAdjustmentsHorizontal, IconHome, IconLayoutGrid, IconServer2, IconShieldCheck } from "@tabler/icons-react";
import type { MessageKey } from "../../i18n/t";

export const mainNav = [
  { to: "/", label: "nav.dashboard", icon: IconHome, exact: true },
  { to: "/nodes", label: "nav.nodes", icon: IconServer2, exact: false },
  { to: "/templates", label: "nav.templates", icon: IconLayoutGrid, exact: false },
  { to: "/activity", label: "nav.activity", icon: IconActivity, exact: false },
  { to: "/approvals", label: "nav.approvals", icon: IconShieldCheck, exact: false },
  { to: "/settings", label: "nav.settings", icon: IconAdjustmentsHorizontal, exact: false },
] as const satisfies readonly { to: string; label: MessageKey; icon: unknown; exact: boolean }[];
