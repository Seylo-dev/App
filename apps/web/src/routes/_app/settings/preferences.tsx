// Settings > Preferences (your account): choices that only change what the
// signed-in person sees, kept in their auth.preferences so they follow them
// across browsers. The Sidebar card has a switch per main navigation item
// but Settings (all on by default; off takes the item out of the sidebar
// only, lib/use-sidebar-items.ts) and whether the sidebar ends with the
// folded "Hidden (N)" group of hidden projects (on by default,
// lib/use-hidden-projects.ts). Each switch saves at once and the sidebar
// follows.

import { auth, system } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { SettingRowSkeleton } from "../../../components/settings/skeletons";
import { canHide, type MainNavItem, mainNav } from "../../../components/shell/nav-items";
import { t } from "../../../i18n/t";
import { useHiddenProjects } from "../../../lib/use-hidden-projects";
import { useSidebarItems } from "../../../lib/use-sidebar-items";

export const Route = createFileRoute("/_app/settings/preferences")({
  component: PreferencesPage,
});

/** The items with a switch: every main navigation item but Settings, in sidebar order. */
const hideable = mainNav.filter((item): item is Exclude<MainNavItem, { id: "settings" }> => canHide(item));

function PreferencesPage() {
  const preferences = useOp(auth.preferences, {});
  const hiding = useHiddenProjects();
  const items = useSidebarItems();
  const features = useOp(system.features, {});
  // Approvals is in the navigation only once MCP or the assistant is on (nav-items.ts showApprovals): its hint says so.
  const approvalsIdle = features.data !== undefined && !features.data.mcp.enabled && !features.data.ai.enabled;
  return (
    <SettingsPage title={t("settingsPreferences.title")} subtitle={t("settingsPreferences.subtitle")}>
      <SectionCard title={t("settingsPreferences.sidebar.title")} description={t("settingsPreferences.sidebar.description")}>
        <QueryView
          query={preferences}
          skeleton={
            <div className="flex flex-col">
              {hideable.map((item) => (
                <SettingRowSkeleton key={item.id} titleWidth="w-24" description={item.id === "approvals"} />
              ))}
              <SettingRowSkeleton titleWidth="w-56" />
            </div>
          }
        >
          {() => (
            // One column without the card's gap: the rows' own padding and lines space this list.
            <div className="flex flex-col">
              {hideable.map((item) => (
                <SettingRow
                  key={item.id}
                  title={
                    <span className="inline-flex items-center gap-2">
                      <item.icon size={16} stroke={1.8} aria-hidden="true" className="text-muted-foreground" />
                      {t(item.label)}
                    </span>
                  }
                  description={
                    item.id === "approvals"
                      ? t(approvalsIdle ? "settingsPreferences.sidebar.approvalsHintIdle" : "settingsPreferences.sidebar.approvalsHint")
                      : undefined
                  }
                  control={
                    <Switch
                      checked={!items.hidden.has(item.id)}
                      disabled={items.saving}
                      aria-label={t("settingsPreferences.sidebar.showItem", { name: t(item.label) })}
                      onCheckedChange={(on) => items.setShown(item.id, on)}
                    />
                  }
                />
              ))}
              <SettingRow
                title={t("settingsPreferences.sidebar.showHidden")}
                description={t("settingsPreferences.sidebar.showHiddenHint")}
                control={
                  <Switch
                    checked={hiding.showInSidebar}
                    disabled={hiding.savingChoice}
                    aria-label={t("settingsPreferences.sidebar.showHidden")}
                    onCheckedChange={hiding.setShowInSidebar}
                  />
                }
              />
            </div>
          )}
        </QueryView>
      </SectionCard>
    </SettingsPage>
  );
}
