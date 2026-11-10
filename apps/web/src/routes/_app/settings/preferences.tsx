// Settings > Preferences (your account): choices that only change what the
// signed-in person sees, kept in their auth.preferences so they follow them
// across browsers. For now one switch: whether the sidebar ends with the
// folded "Hidden (N)" group of hidden projects (on by default). The switch
// saves at once and the sidebar follows (lib/use-hidden-projects.ts).

import { auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { SectionCard } from "@seylo/ui/components/section-card";
import { Switch } from "@seylo/ui/components/switch";
import { createFileRoute } from "@tanstack/react-router";
import { QueryView } from "../../../components/settings/op-state";
import { SettingRow, SettingsPage } from "../../../components/settings/page";
import { SettingRowSkeleton } from "../../../components/settings/skeletons";
import { t } from "../../../i18n/t";
import { useHiddenProjects } from "../../../lib/use-hidden-projects";

export const Route = createFileRoute("/_app/settings/preferences")({
  component: PreferencesPage,
});

function PreferencesPage() {
  const preferences = useOp(auth.preferences, {});
  const hiding = useHiddenProjects();
  return (
    <SettingsPage title={t("settingsPreferences.title")} subtitle={t("settingsPreferences.subtitle")}>
      <SectionCard title={t("settingsPreferences.sidebar.title")} description={t("settingsPreferences.sidebar.description")}>
        <QueryView query={preferences} skeleton={<SettingRowSkeleton titleWidth="w-56" />}>
          {() => (
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
          )}
        </QueryView>
      </SectionCard>
    </SettingsPage>
  );
}
