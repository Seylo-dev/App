// The UI kit's own words (Copy, Cancel, Search output, ...) from the i18n
// catalog. main.tsx passes them to <UiLabelsProvider>.

import type { UiLabels } from "@seylo/ui/components/labels";
import { t } from "../i18n/t";

export function uiLabels(): UiLabels {
  return {
    copy: t("kit.copy"),
    copied: t("kit.copied"),
    show: t("kit.show"),
    hide: t("kit.hide"),
    close: t("kit.close"),
    cancel: t("kit.cancel"),
    confirm: t("kit.confirm"),
    // {value} and {count} are filled by the kit, so read the raw messages.
    typeToConfirm: t("kit.typeToConfirm"),
    rowActions: t("kit.rowActions"),
    actions: t("kit.actions"),
    sortAscending: t("kit.sortAscending"),
    sortDescending: t("kit.sortDescending"),
    noRows: t("kit.noRows"),
    notifications: t("kit.notifications"),
    dismiss: t("kit.dismiss"),
    showOrHide: t("kit.showOrHide"),
    searchOutput: t("kit.searchOutput"),
    matches: t("kit.matches"),
    nextMatch: t("kit.nextMatch"),
    previousMatch: t("kit.previousMatch"),
    followOutput: t("kit.followOutput"),
    jumpToLatest: t("kit.jumpToLatest"),
    noOutput: t("kit.noOutput"),
    loading: t("kit.loading"),
  };
}
