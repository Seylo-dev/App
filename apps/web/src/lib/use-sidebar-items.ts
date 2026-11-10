// Main navigation items the signed-in person took out of their sidebar
// (auth.preferences.hiddenSidebarItems, Settings > Preferences). The panel
// keeps the list per person, so it follows them across browsers, and keeps
// only names it knows. A change shows at once (the cached preferences are
// patched); a failed save refetches them. Only the sidebar reads the list
// (components/shell/use-main-nav.ts useSidebarNav): the command palette,
// links and the pages themselves ignore it.

import { auth, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "../i18n/t";
import { errorMessage } from "./api";

type Preferences = OpOutput<typeof auth.preferences>;
const preferencesKey = opQueryKey(auth.preferences, {});

/** The names of the items the person turned off; none until the preferences answer and after a failed read. */
export function hiddenSidebarItems(preferences: Preferences["preferences"] | undefined): ReadonlySet<string> {
  return new Set(preferences?.hiddenSidebarItems ?? []);
}

/** The list to save after turning one item on or off: each name once, and an item turned on leaves it. */
export function withSidebarItem(current: readonly string[], item: auth.SidebarItemName, show: boolean): auth.SidebarItemName[] {
  const rest = current.filter((name): name is auth.SidebarItemName => name !== item);
  return show ? rest : [...rest, item];
}

export function useSidebarItems() {
  const queryClient = useQueryClient();
  const preferences = useOp(auth.preferences, {});
  const save = useOpMutation(auth.updatePreferences, {
    onSuccess: () => toast.success(t("settings.saved")),
    onError: (error) => {
      toast.error(t("settingsPreferences.saveFailed"), { description: errorMessage(error, t("common.unknownError")) });
      void queryClient.invalidateQueries({ queryKey: preferencesKey });
    },
  });

  /** Shows or leaves out one item. Only this key is sent, so it never touches the other preferences. */
  function setShown(item: auth.SidebarItemName, show: boolean): void {
    const cached = queryClient.getQueryData<Preferences>(preferencesKey);
    // The list never loaded (its read failed): saving now would turn the others back on, so it is read again instead.
    if (!cached) {
      toast.error(t("settingsPreferences.saveFailed"), { description: errorMessage(preferences.error, t("common.unknownError")) });
      void preferences.refetch();
      return;
    }
    // A read still on its way would put the old list back.
    void queryClient.cancelQueries({ queryKey: preferencesKey });
    const next = withSidebarItem(cached.preferences.hiddenSidebarItems ?? [], item, show);
    const { hiddenSidebarItems: _stored, ...rest } = cached.preferences;
    queryClient.setQueryData<Preferences>(preferencesKey, { preferences: next.length > 0 ? { ...rest, hiddenSidebarItems: next } : rest });
    save.mutate({ preferences: { hiddenSidebarItems: next.length > 0 ? next : null } });
  }

  return {
    hidden: hiddenSidebarItems(preferences.data?.preferences),
    setShown,
    saving: save.isPending,
  };
}
