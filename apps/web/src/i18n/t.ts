// Every string the web app shows goes through t(). Keys are dotted paths
// into the catalog, checked at compile time: "<section>.<key>", where each
// section is one file in en/ (en/dashboard.ts holds "dashboard.*"), so
// screens add their own section file instead of editing a shared one.
// Values may contain {name} placeholders, and plural messages are
// { one, other } objects chosen by the {count} parameter with
// Intl.PluralRules. Product names come from @seylo/brand at the call site
// ({name}), never from the catalog, so white-label builds stay correct.
//
// Adding a language later means adding a catalog with the same shape and
// calling setCatalog(); no component changes.

import { en } from "./en/index.gen";

type Plural = { one: string; other: string };
type Messages = { readonly [key: string]: string | Plural | Messages };

/** "nav.dashboard", "dashboard.subtitle", ... : every leaf of the catalog. */
type Keys<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string | Plural ? `${Prefix}${K}` : Keys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Keys<typeof en>;
export type Params = Record<string, string | number>;

let catalog: Messages = en;
let locale = "en";
let plurals = new Intl.PluralRules(locale);

export function setCatalog(next: Messages, nextLocale: string): void {
  catalog = next;
  locale = nextLocale;
  plurals = new Intl.PluralRules(locale);
}

export function t(key: MessageKey, params?: Params): string {
  const message = lookup(key);
  if (message === undefined) return key;
  const text = typeof message === "string" ? message : pickPlural(message, params?.count);
  return params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;
}

function lookup(key: string): string | Plural | undefined {
  let node: Messages | string | Plural | undefined = catalog;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = (node as Messages)[part];
  }
  return node as string | Plural | undefined;
}

function pickPlural(message: Plural, count: string | number | undefined): string {
  return plurals.select(Number(count ?? 0)) === "one" ? message.one : message.other;
}
