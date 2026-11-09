// The sidebar from the design (Sidebar.dc.html): brand and version,
// command palette trigger, main navigation, the projects tree, the nodes
// card and the signed-in person. Under the md breakpoint only the brand
// row and a menu button show; the rest opens below them and closes again
// on navigation. The selected item's background is one shared element
// (layoutId "sidebar-nav", also used by the service rows in the projects
// tree) that slides to the item you click.

import { displayName } from "@seylo/brand";
import { approvals, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { Chip } from "@seylo/ui/components/chip";
import { Kbd } from "@seylo/ui/components/kbd";
import { ActiveIndicator } from "@seylo/ui/components/motion";
import { Skeleton } from "@seylo/ui/components/skeleton";
import { cn } from "@seylo/ui/lib/utils";
import { IconMenu2, IconSearch, IconX } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { m } from "motion/react";
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
    // layoutRoot: the sidebar is sticky, so the sliding background measures against it, not the scrolled page.
    <m.nav
      layoutRoot
      aria-label={t("nav.main")}
      className="box-border flex w-full flex-col gap-3.5 bg-sidebar px-3.5 pt-[18px] pb-3.5 text-sidebar-foreground shadow-sidebar md:sticky md:top-0 md:h-dvh md:w-[248px] md:shrink-0 md:overflow-y-auto"
    >
      <div className="flex items-center gap-2.5 px-1.5 py-0.5">
        {/* The mark and name go home (the dashboard), as in most apps. */}
        <Link
          to="/"
          aria-label={t("nav.home", { name: info.data?.name ?? displayName })}
          className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-control text-inherit no-underline"
        >
          <BrandMark />
          <span className="truncate text-base font-semibold tracking-[-0.015em]">{info.data?.name ?? displayName}</span>
        </Link>
        {info.data ? (
          <Chip tone="blue" mono className="ml-auto px-[7px] py-0.5 text-[11px]">
            {info.data.version === "dev" ? "dev" : `v${info.data.version}`}
          </Chip>
        ) : (
          // The version chip's own size, so the brand row does not move when it arrives.
          info.isPending && <Skeleton className="ml-auto h-5 w-[52px] rounded-chip" />
        )}
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-controls="sidebar-menu"
          aria-label={t(menuOpen ? "nav.closeMenu" : "nav.openMenu")}
          onClick={() => setMenuOpen((open) => !open)}
          className={cn(
            "flex cursor-pointer rounded-control border-0 bg-transparent p-1.5 text-ink-strong hover:bg-muted md:hidden",
            !info.data && !info.isPending && "ml-auto",
          )}
        >
          {menuOpen ? <IconX size={19} stroke={1.8} /> : <IconMenu2 size={19} stroke={1.8} />}
        </button>
      </div>

      <div id="sidebar-menu" className={cn("min-h-0 flex-1 flex-col gap-3.5 md:flex", menuOpen ? "flex" : "hidden")}>
        <button
          type="button"
          onClick={shell.openPalette}
          className="flex h-[38px] w-full cursor-pointer items-center gap-2 rounded-control border-0 bg-field pr-2.5 pl-3 text-[13px] text-muted-foreground hover:text-foreground"
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
              className="relative isolate flex items-center gap-[11px] rounded-control px-2.5 py-2 text-[13.5px] text-ink-strong hover:bg-muted hover:text-foreground data-[status=active]:text-accent-foreground"
            >
              {({ isActive }) => (
                <>
                  {isActive && <ActiveIndicator layoutId="sidebar-nav" className="rounded-control bg-accent" />}
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
                </>
              )}
            </Link>
          ))}
        </div>

        <ProjectsTree />

        <div className="flex-1" />
        <NodesCard online={info.data?.nodes.online} total={info.data?.nodes.total} loading={info.isPending} />
        <UserRow />
      </div>
    </m.nav>
  );
}
