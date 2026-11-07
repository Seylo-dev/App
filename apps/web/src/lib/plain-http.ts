// Whether this page reached the panel over plain HTTP on a real network
// address (the first-run IP:port), where the setup token, passwords and the
// session cross the network unencrypted. Loopback counts as secure (the
// SSH tunnel the warning suggests), like the browser's isSecureContext.

export interface PlainHttpPage {
  /** The address to tunnel to, without IPv6 brackets. */
  host: string;
  port: string;
}

export function plainHttpPage(location: Pick<Location, "protocol" | "hostname" | "port">, secureContext: boolean): PlainHttpPage | null {
  if (secureContext || location.protocol !== "http:") return null;
  return { host: location.hostname.replace(/^\[(.*)\]$/, "$1"), port: location.port || "80" };
}
