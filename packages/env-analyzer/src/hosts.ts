// A service's internal host name typed literally into a value: "db:5432",
// "postgres://u:p@db/app", "//db", or a value that is just "db". The
// analyzer flags these when the service runs on another node; the panel
// lists them when a service moves to another project (its host name stops
// resolving there).

export interface HostMention {
  /** Offset of the host in the searched text. */
  from: number;
  /** The host as written (case kept). */
  host: string;
  /** ":5432", or "" without a port. */
  port: string;
}

/** Where `host` appears as a host name in `raw` (case-insensitive). */
export function hostMentions(raw: string, host: string): HostMention[] {
  if (host === "") return [];
  const name = escapeRegExp(host);
  const pattern = new RegExp(`(^|@|//)(${name})(:\\d{1,5})?(?=$|[/?#\\s,;])|(^|[\\s,;=(])(${name}):(\\d{1,5})(?=$|[/?#\\s,;)])`, "gi");
  const out: HostMention[] = [];
  for (const match of raw.matchAll(pattern)) {
    const prefix = match[1] ?? match[4] ?? "";
    const hostText = match[2] ?? match[5] ?? "";
    const port = match[3] ?? (match[6] ? `:${match[6]}` : "");
    // A bare name only counts when it is the whole value.
    if (prefix === "" && match.index === 0 && port === "" && hostText.length !== raw.trim().length) continue;
    out.push({ from: (match.index ?? 0) + prefix.length, host: hostText, port });
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
