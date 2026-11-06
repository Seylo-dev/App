// The settings layout: the section list on the left (a scrolling row on
// phones) and the section on the right. Each section renders its own
// title row, as in the design boards.

import { cn } from "@seylo/ui/lib/utils";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import type * as React from "react";
import { accountNav, type SettingsNavItem, settingsNav } from "../../components/settings-nav";
import { t } from "../../i18n/t";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:gap-7">
      <nav
        aria-label={t("settings.title")}
        className="-mx-4 flex shrink-0 gap-0.5 overflow-x-auto px-4 pb-1 text-[13.5px] md:mx-0 md:w-[190px] md:flex-col md:overflow-visible md:px-0 md:pb-0"
      >
        <GroupLabel>{t("settings.title")}</GroupLabel>
        {settingsNav.map((item) => (
          <NavLink key={item.to} item={item} />
        ))}
        <GroupLabel className="md:mt-3">{t("settings.accountGroup")}</GroupLabel>
        {accountNav.map((item) => (
          <NavLink key={item.to} item={item} />
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function GroupLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("hidden px-2.5 pt-1 pb-2 text-xs font-medium text-muted-foreground md:block", className)}>{children}</span>;
}

function NavLink({ item }: { item: SettingsNavItem }) {
  return (
    <Link
      to={item.to}
      className="shrink-0 whitespace-nowrap rounded-control px-2.5 py-2 text-ink-strong hover:bg-muted hover:text-foreground data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-accent-foreground"
    >
      {t(item.label)}
    </Link>
  );
}
