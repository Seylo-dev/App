// Agent version policy. The panel supports agents up to two minor releases
// older than itself (N-2); a signed release manifest may raise the floor
// (minAgent). Development builds ("dev", git describe output without a
// version) are never refused, so local agents always connect.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release part without the hyphen, "" for releases. */
  pre: string;
}

/**
 * "v1.2.3", "1.2.3-rc.1" and "1.2.3+meta" parse, also with the build note
 * older agents append ("0.1.0 (commit abc1234, built 2026-11-05)"); anything
 * else is null.
 */
export function parseVersion(text: string | null | undefined): SemVer | null {
  const match = text?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:\s+\(commit [^)]*\))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? "" };
}

/** Negative when a < b, 0 when equal, positive when a > b. A pre-release sorts before its release. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return comparePre(a.pre, b.pre);
}

function comparePre(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null && xn !== yn) return xn - yn;
    if (xn !== null && yn === null) return -1;
    if (xn === null && yn !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` is a newer release than `current` (unparseable versions are never newer). */
export function isNewer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a) return false;
  if (!b) return current !== candidate && !isDevVersion(current);
  return compareVersions(a, b) > 0;
}

export function isDevVersion(version: string | null | undefined): boolean {
  return parseVersion(version) === null;
}

/**
 * The oldest agent this panel accepts: the higher of N-2 minor releases
 * and the manifest's minAgent. Null means no floor (a dev panel and no manifest).
 */
export function minimumAgentVersion(panelVersion: string, manifestMinAgent: string | null): string | null {
  const panel = parseVersion(panelVersion);
  const fromPanel = panel ? `${panel.major}.${Math.max(0, panel.minor - 2)}.0` : null;
  const fromManifest = parseVersion(manifestMinAgent) ? (manifestMinAgent as string).replace(/^v/, "") : null;
  if (!fromPanel) return fromManifest;
  if (!fromManifest) return fromPanel;
  return compareVersions(parseVersion(fromPanel) as SemVer, parseVersion(fromManifest) as SemVer) >= 0 ? fromPanel : fromManifest;
}

/** Whether an agent may connect. Dev agents always may. */
export function agentVersionAllowed(agentVersion: string, minimum: string | null): boolean {
  if (!minimum) return true;
  const agent = parseVersion(agentVersion);
  const floor = parseVersion(minimum);
  if (!agent || !floor) return true;
  // Pre-releases of the floor count as the floor (an rc of 1.4.0 may join a panel that needs 1.4.0).
  return compareVersions({ ...agent, pre: "" }, floor) >= 0;
}
