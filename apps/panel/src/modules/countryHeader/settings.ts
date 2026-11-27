// The country header's settings key and how it reads.

import type { PanelDb } from "../../db/client";
import type { SealPurpose, SecretBox } from "../../security/secret-box";
import { getSetting } from "../../settings";

declare module "../../settings" {
  interface SettingValues {
    /**
     * The visitor country header (X-Seylo-Country). Missing means on with
     * no MaxMind account. The license key is sealed with purpose
     * "country-header.maxmind". updatedAt in ms.
     */
    countryHeader: { enabled: boolean; maxmindAccountId: string | null; maxmindLicenseKeySealed: string | null; updatedAt: number };
  }
}

/** The MaxMind license key's sealing purpose. */
export const maxmindKeyPurpose: SealPurpose = "country-header.maxmind";

export interface CountryHeaderStored {
  enabled: boolean;
  maxmindAccountId: string | null;
  maxmindLicenseKeySealed: string | null;
}

/** The stored setting, on by default. */
export function readCountryHeader(db: PanelDb): CountryHeaderStored {
  const stored = getSetting(db, "countryHeader");
  return {
    enabled: stored?.enabled !== false,
    maxmindAccountId: stored?.maxmindAccountId ?? null,
    maxmindLicenseKeySealed: stored?.maxmindLicenseKeySealed ?? null,
  };
}

/** The MaxMind account nodes get: both parts or none (also when the key no longer opens). */
export function maxmindAccount(db: PanelDb, secrets: SecretBox): { accountId: string; licenseKey: string } | null {
  const stored = readCountryHeader(db);
  if (!stored.maxmindAccountId || !stored.maxmindLicenseKeySealed) return null;
  const licenseKey = secrets.open(stored.maxmindLicenseKeySealed, maxmindKeyPurpose);
  return licenseKey ? { accountId: stored.maxmindAccountId, licenseKey } : null;
}
