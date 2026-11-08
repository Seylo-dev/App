// Projects the signed-in person hid from the sidebar and the home page
// (auth.preferences.hiddenProjectIds), shared by both. The panel keeps the
// list per person, so it follows them across browsers. A change shows at
// once (the cached preferences are patched); a failed save refetches them.
// The command palette, links and the project pages ignore the list.

import { auth, type OpOutput } from "@seylo/ops";
import { opQueryKey, useOp, useOpMutation } from "@seylo/ops/react";
import { toast } from "@seylo/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { t } from "../i18n/t";
import { errorMessage } from "./api";

type Preferences = OpOutput<typeof auth.preferences>;
const preferencesKey = opQueryKey(auth.preferences, {});
export const maxHiddenProjects = auth.HiddenProjectIds.maxItems as number;

/** Splits projects into the ones shown and the hidden ones, each in list order. */
export function splitHidden<P extends { id: string }>(projects: readonly P[], hidden: ReadonlySet<string>): { shown: P[]; hidden: P[] } {
  const shown: P[] = [];
  const out: P[] = [];
  for (const project of projects) (hidden.has(project.id) ? out : shown).push(project);
  return { shown, hidden: out };
}

/** The list to save after hiding or unhiding one project: newest last, each id once. */
export function withHidden(current: readonly string[], projectId: string, hide: boolean): string[] {
  const rest = current.filter((id) => id !== projectId);
  return hide ? [...rest, projectId] : rest;
}

export function useHiddenProjects() {
  const queryClient = useQueryClient();
  const preferences = useOp(auth.preferences, {});
  const save = useOpMutation(auth.updatePreferences, {
    onError: (error) => {
      toast.error(t("sidebar.hideFailed"), { description: errorMessage(error, t("common.unknownError")) });
      void queryClient.invalidateQueries({ queryKey: preferencesKey });
    },
  });
  const ids = preferences.data?.preferences.hiddenProjectIds;
  const hidden = useMemo<ReadonlySet<string>>(() => new Set(ids ?? []), [ids]);

  function setHidden(project: { id: string; name: string }, hide: boolean): void {
    const current = queryClient.getQueryData<Preferences>(preferencesKey)?.preferences ?? {};
    const list = current.hiddenProjectIds ?? [];
    if (hide && !list.includes(project.id) && list.length >= maxHiddenProjects) {
      toast.error(t("sidebar.hideLimit", { count: maxHiddenProjects }));
      return;
    }
    const next = withHidden(list, project.id, hide);
    // A read still on its way would put the old list back.
    void queryClient.cancelQueries({ queryKey: preferencesKey });
    queryClient.setQueryData<Preferences>(preferencesKey, { preferences: { ...current, hiddenProjectIds: next } });
    save.mutate({ preferences: { hiddenProjectIds: next.length > 0 ? next : null } });
    if (hide) {
      toast(t("sidebar.hiddenToast", { name: project.name }), {
        description: t("sidebar.hiddenToastHint"),
        action: { label: t("sidebar.undo"), onClick: () => setHidden(project, false) },
      });
    }
  }

  return {
    hidden,
    /** True until the preferences answer, so a hidden project does not show for a moment. A failed read hides nothing. */
    pending: preferences.isPending,
    setHidden,
  };
}
