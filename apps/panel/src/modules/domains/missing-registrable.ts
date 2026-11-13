// What a caller hears about a host whose registrable domain does not exist
// (zone.ts): domains.checkDns and domains.add answer zoneMissing with a
// "Did you mean" from what the caller can see (did-you-mean.ts), and
// domains.add and domains.addAuto add the domain anyway with a warning, so
// it works once the domain is registered or the typo is fixed elsewhere.

import { type SuggestionCaller, suggestRegistrable } from "./did-you-mean";
import { type DnsLookups, dnsLookups } from "./dns";
import { findZone, registrableMissingMessage } from "./zone";

interface RegistrableAnswer {
  zoneMissing: boolean;
  registrable: string | null;
  message: string;
}

export interface MissingRegistrableWarning {
  reason: "registrableMissing";
  message: string;
  registrable: string;
  didYouMean?: string;
}

/** The check with didYouMean, and the question at the end of its message, when its registrable domain does not exist. */
export function withSuggestion<T extends RegistrableAnswer>(caller: SuggestionCaller, dns: T): T & { didYouMean?: string } {
  if (!dns.zoneMissing || !dns.registrable) return dns;
  const didYouMean = suggestRegistrable(caller, dns.registrable);
  return didYouMean ? { ...dns, didYouMean, message: `${dns.message} Did you mean ${didYouMean}?` } : dns;
}

/** The warning a domain just added carries when its check said the registrable domain does not exist. */
export function missingWarning(dns: RegistrableAnswer & { didYouMean?: string }): MissingRegistrableWarning | null {
  if (!dns.zoneMissing || !dns.registrable) return null;
  return {
    reason: "registrableMissing",
    message: dns.message,
    registrable: dns.registrable,
    ...(dns.didYouMean ? { didYouMean: dns.didYouMean } : {}),
  };
}

/**
 * For a host added without a DNS check (an automatic domain): the NS
 * lookups up to its registrable domain alone (cached, zone.ts). A lookup
 * that fails says nothing, so no warning.
 */
export async function registrableWarning(
  caller: SuggestionCaller,
  host: string,
  lookups: DnsLookups = dnsLookups(),
): Promise<MissingRegistrableWarning | null> {
  try {
    const zone = await findZone(host, lookups);
    if (!zone.registrableMissing || !zone.registrable) return null;
    const answer = { zoneMissing: true, registrable: zone.registrable, message: registrableMissingMessage(zone.registrable) };
    return missingWarning(withSuggestion(caller, answer));
  } catch {
    return null;
  }
}
