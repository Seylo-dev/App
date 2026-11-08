// Panel settings the updates module owns (see src/settings.ts).

declare module "../../settings" {
  interface SettingValues {
    /** The one auto-update switch for the panel and every node. Default off until the owner turns it on. */
    autoUpdate: boolean;
    /**
     * Which releases the check looks at (updates.setChannel, owner only):
     * "stable" (GitHub's latest release, the default) or "prerelease" (the
     * highest version of all releases, release candidates included).
     */
    updateChannel: "stable" | "prerelease";
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
      /** The channel this release was found on; absent (checks before 0.2.0-rc.2) means stable. */
      channel?: "stable" | "prerelease";
    };
    /**
     * The minAgent of the release the panel runs, kept from the last
     * verified check that found that version, so a check that later finds a
     * newer release does not lose it (release-state.ts runningMinAgent).
     */
    runningRelease: { version: string; minAgent: string | null };
  }
}

export {};
