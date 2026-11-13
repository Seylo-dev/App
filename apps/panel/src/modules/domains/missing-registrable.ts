// What a caller hears about a host whose registrable domain does not exist
// (zone.ts): domains.checkDns and domains.add answer zoneMissing with a
// "Did you mean" from what the caller can see (did-you-mean.ts), and
// domains.add and domains.addAuto add the domain anyway with a warning, so
// it works once the domain is registered or the typo is fixed elsewhere.

import { type SuggestionCaller, suggestRegistrable } from "./did-you-mean";
import { type DnsLookups, dnsLookups } from "./dns";
import { findZone, isPrivateName, nsCacheMs, registrableDomain, registrableMissingMessage } from "./zone";

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

/** How long domains.addAuto waits on the lookups before it answers without a warning; they go on and fill the NS cache. */
export const warningWaitMs = 2500;
let waitMs = warningWaitMs;

/** Tests shorten the wait. */
export function setWarningWait(ms: number | null): void {
  waitMs = ms ?? warningWaitMs;
}

/**
 * Registrable domains whose lookups failed or ran past the wait, per
 * DnsLookups: not asked again for a minute, so on a panel that cannot
 * reach the public resolvers every addAuto answers at once instead of
 * waiting again. A late answer clears it (the NS cache has it then).
 */
const unsure = new WeakMap<DnsLookups, Map<string, number>>();
const unsureMax = 1000;

function unsureOf(lookups: DnsLookups): Map<string, number> {
  let map = unsure.get(lookups);
  if (!map) {
    map = new Map();
    unsure.set(lookups, map);
  }
  return map;
}

/**
 * The host's registrable domain when it does not exist, else null. As in
 * checkHost, a record answering for the host proves the name exists,
 * whatever the NS lookups said (a registrable domain served straight from
 * its suffix's zone, with no delegation of its own).
 */
async function missingRegistrable(host: string, lookups: DnsLookups): Promise<string | null> {
  const zone = await findZone(host, lookups);
  if (!zone.registrableMissing || !zone.registrable) return null;
  const answers = await Promise.all([lookups.resolve4(host), lookups.resolve6(host), lookups.resolveCname(host)]);
  return answers.some((records) => records.length > 0) ? null : zone.registrable;
}

const late = Symbol("late");

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof late> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof late>((resolve) => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For a host added without a DNS check (an automatic domain): the NS
 * lookups up to its registrable domain (cached, zone.ts), then the host's
 * own records. Bounded by the wait; a lookup that fails or runs past it
 * says nothing, so no warning, and a private name (lab.internal,
 * localhost, ...) asks nothing.
 */
export async function registrableWarning(
  caller: SuggestionCaller,
  host: string,
  lookups: DnsLookups = dnsLookups(),
): Promise<MissingRegistrableWarning | null> {
  const domain = registrableDomain(host)?.domain;
  if (!domain || isPrivateName(host)) return null;
  const memo = unsureOf(lookups);
  const since = memo.get(domain);
  if (since !== undefined && Date.now() - since < nsCacheMs) return null;
  const lookup = missingRegistrable(host, lookups);
  const remember = () => {
    if (memo.size >= unsureMax) memo.clear();
    memo.set(domain, Date.now());
  };
  lookup.then(() => memo.delete(domain), remember);
  let registrable: string | null;
  try {
    const answer = await within(lookup, waitMs);
    if (answer === late) {
      remember();
      return null;
    }
    registrable = answer;
  } catch {
    return null;
  }
  if (!registrable) return null;
  const answer = { zoneMissing: true, registrable, message: registrableMissingMessage(registrable) };
  return missingWarning(withSuggestion(caller, answer));
}
