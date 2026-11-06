// The sidebar from the design (Sidebar.dc.html): brand and version,
// command palette trigger, main navigation, the projects tree, the nodes
// card and the signed-in person. Under the md breakpoint only the brand
// row and a menu button show; the rest opens below them and closes again
// on navigation.

import { displayName } from "@seylo/brand";
import { approvals, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip } from "@seylo/ui/components/chip";
import { Kbd } from "@seylo/ui/components/kbd";
import { cn } from "@seylo/ui/lib/utils";
import { IconMenu2, IconSearch, IconX } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { useLiveUp } from "../../lib/live";
import { BrandMark } from "../brand-mark";
import { mainNav } from "./nav-items";
import { NodesCard } from "./nodes-card";
import { ProjectsTree } from "./projects-tree";
import { useShell } from "./shell-context";
import { UserRow } from "./user-row";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Sidebar() {
  const shell = useShell();
  const info = useOp(system.info, {});
  // The panel filters approvals per person, so this is what waits for the viewer.
  // The panel topic refreshes it the moment a request arrives or is decided; poll only while the socket is down.
  const liveUp = useLiveUp();
  const pending = useOp(approvals.list, { status: "pending", limit: 1 }, { retry: false, refetchInterval: liveUp ? false : 30_000 });
  const pendingCount = pending.data?.pendingCount ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const path = useRouterState({ select: (state) => state.location.pathname });

  // Leaving a page closes the phone menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger, not an input
  useEffect(() => setMenuOpen(false), [path]);

  return (
    <nav
      aria-label={t("nav.main")}
      className="box-border flex w-full flex-col gap-3.5 bg-sidebar px-3.5 pt-[18px] pb-3.5 text-sidebar-foreground shadow-sidebar md:sticky md:top-0 md:h-dvh md:w-[248px] md:shrink-0 md:overflow-y-auto"
    >
      <div className="flex items-center gap-2.5 px-1.5 py-0.5">
        <BrandMark />
        <span className="text-base font-semibold tracking-[-0.015em]">{info.data?.name ?? displayName}</span>
        {info.data && (
          <Chip tone="blue" mono className="ml-auto px-[7px] py-0.5 text-[11px]">
            {info.data.version === "dev" ? "dev" : `v${info.data.version}`}
          </Chip>
        )}
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="sidebar-menu"
          aria-label={t(menuOpen ? "nav.closeMenu" : "nav.openMenu")}
          onClick={() => setMenuOpen((open) => !open)}
          className={cn(
            "flex cursor-pointer rounded-control border-0 bg-transparent p-1.5 text-ink-strong hover:bg-muted md:hidden",
            !info.data && "ml-auto",
          )}
        >
          {menuOpen ? <IconX size={19} stroke={1.8} /> : <IconMenu2 size={19} stroke={1.8} />}
        </button>
      </div>

      <div id="sidebar-menu" className={cn("min-h-0 flex-1 flex-col gap-3.5 md:flex", menuOpen ? "flex" : "hidden")}>
        <button
          type="button"
          onClick={shell.openPalette}
          className="flex h-[38px] w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-field pr-2.5 pl-3 text-[13px] text-muted-foreground"
        >
          <IconSearch size={15} stroke={1.8} aria-hidden="true" />
          <span className="truncate">{t("nav.search")}</span>
          <Kbd className="ml-auto">{isMac ? "⌘K" : "Ctrl K"}</Kbd>
        </button>

        <div className="flex flex-col gap-0.5">
          {mainNav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              className="flex items-center gap-[11px] rounded-control px-2.5 py-2 text-[13.5px] text-ink-strong hover:bg-muted hover:text-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground"
            >
              <item.icon size={17} stroke={1.8} aria-hidden="true" />
              {t(item.label)}
              {item.to === "/nodes" && info.data && (
                <span className="ml-auto rounded-chip bg-muted px-[7px] py-px text-[11.5px] font-medium text-ink-strong">
                  {info.data.nodes.total}
                </span>
              )}
              {item.to === "/approvals" && pendingCount > 0 && (
                <span className="ml-auto rounded-chip bg-chip-amber-bg px-[7px] py-px text-[11.5px] font-medium text-chip-amber-fg">
                  {pendingCount}
                </span>
              )}
            </Link>
          ))}
        </div>

        <ProjectsTree />

        <div className="flex-1" />
        <NodesCard online={info.data?.nodes.online} total={info.data?.nodes.total} />
        <UserRow />
      </div>
    </nav>
  );
}
