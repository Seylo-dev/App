// "Come back here afterwards" links (?redirect= on /login and /reauth).
// Only paths on this panel pass, so a crafted link cannot send someone to
// another site after they signed in or confirmed it's them. Parsing with
// URL catches the tricks a prefix check misses ("/\evil.example" is
// "//evil.example" to a browser).

export function safeRedirectPath(value: unknown, origin: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return undefined;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}
