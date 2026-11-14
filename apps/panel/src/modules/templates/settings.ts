// Panel settings the templates module owns (see src/settings.ts).

declare module "../../settings" {
  interface SettingValues {
    /**
     * Where catalog templates come from (templates.setCatalogSource, owner
     * only). Unset means the default: the official catalog on, no private
     * catalog.
     */
    templatesCatalog: {
      /** false: only the copy that ships with the panel (no downloads). */
      official: boolean;
      /** One more catalog added to the official one. */
      extra: { url: string; publicKey: string | null; allowUnsigned: boolean } | null;
    };
    /**
     * What the panel knows about its catalogs (store.ts): the highest
     * sequence it accepted from each (it never goes back to a lower one),
     * the last download and the last error, whether the last check found
     * the official catalog not published yet, and the slugs people with
     * templates.manage have seen (the rest carry a New tag).
     */
    templatesCatalogState: {
      official: CatalogTrack;
      /** `source` is the private catalog's url and key, so a changed setting starts over. */
      extra: (CatalogTrack & { source: string }) | null;
      /** Null until the first start that read a catalog: then every slug it had counts as seen. */
      knownSlugs: string[] | null;
    };
  }
}

export interface CatalogTrack {
  sequence: number | null;
  commit: string | null;
  fetchedAt: string | null;
  lastTriedAt: string | null;
  lastError: string | null;
  /** Official catalog only: the last check got a 404 for catalog.json (none published yet). Not an error. */
  notPublished?: boolean;
}
