// Panel settings the updates module owns (see src/settings.ts).

declare module "../../settings" {
  interface SettingValues {
    /** The one auto-update switch for the panel and every node. Default off until the owner turns it on. */
    autoUpdate: boolean;
    /**
     * Result of the last release check. The verified manifest and its
     * signature are kept as they came (base64) so agents can check the
     * signature themselves (UpdateAgentRequest).
     */
    updateCheck: {
      checkedAt: string;
      latestVersion: string | null;
      changelogUrl: string | null;
      error: string | null;
      /** Oldest agent the release supports; raises the panel's own N-2 floor. */
      minAgent?: string | null;
      manifestBase64?: string | null;
      signatureBase64?: string | null;
    };
  }
}

export {};
