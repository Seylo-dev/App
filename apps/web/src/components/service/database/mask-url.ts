// Connection URLs show with only the password as dots (Database.dc.html),
// so host, port and database stay readable while the secret is hidden.

/** "postgres://user:secret@host/db" -> "postgres://user:••••••@host/db"; other text is all dots. */
export function maskUrlPassword(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@.*)$/i.exec(url);
  if (!match) return "•".repeat(Math.min(Math.max(url.length, 8), 24));
  return `${match[1]}${"•".repeat(Math.min(Math.max(match[2]?.length ?? 0, 6), 16))}${match[3]}`;
}
