// The kit shows a few words of its own (Copy, Cancel, Search output, ...).
// It holds no English: the app passes every string from its i18n catalog
// through <UiLabelsProvider>. Without a provider each label is its own key
// (for example "copy"), the same way t() shows a missing key, so a missing
// provider is visible instead of silently English.

import { createContext, type ReactNode, useContext } from "react";

export interface UiLabels {
  copy: string;
  copied: string;
  show: string;
  hide: string;
  close: string;
  cancel: string;
  confirm: string;
  /** "Type {value} to confirm"; {value} is replaced. */
  typeToConfirm: string;
  rowActions: string;
  actions: string;
  sortAscending: string;
  sortDescending: string;
  noRows: string;
  notifications: string;
  dismiss: string;
  showOrHide: string;
  searchOutput: string;
  /** "{count} matches"; {count} is replaced. */
  matches: string;
  nextMatch: string;
  previousMatch: string;
  followOutput: string;
  jumpToLatest: string;
  noOutput: string;
  loading: string;
}

const keys = [
  "copy",
  "copied",
  "show",
  "hide",
  "close",
  "cancel",
  "confirm",
  "typeToConfirm",
  "rowActions",
  "actions",
  "sortAscending",
  "sortDescending",
  "noRows",
  "notifications",
  "dismiss",
  "showOrHide",
  "searchOutput",
  "matches",
  "nextMatch",
  "previousMatch",
  "followOutput",
  "jumpToLatest",
  "noOutput",
  "loading",
] as const satisfies readonly (keyof UiLabels)[];

/** Every label key as its own value: what the kit shows without a provider. */
export const uiLabelKeys: UiLabels = Object.fromEntries(keys.map((k) => [k, k])) as unknown as UiLabels;

const LabelsContext = createContext<UiLabels>(uiLabelKeys);

export function UiLabelsProvider({ labels, children }: { labels: UiLabels; children: ReactNode }) {
  return <LabelsContext.Provider value={labels}>{children}</LabelsContext.Provider>;
}

export function useUiLabels(): UiLabels {
  return useContext(LabelsContext);
}

/** Replaces {name} placeholders in a label. */
export function fill(label: string, params: Record<string, string | number>): string {
  return label.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
