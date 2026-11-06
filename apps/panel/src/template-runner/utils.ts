// The "~templates-utils" module templates import inside the sandbox. It is
// plain JavaScript evaluated by QuickJS; randomness comes from the host's
// crypto through __hostRandom (hex string of n random bytes).

export const utilsModuleName = "~templates-utils";

export const utilsSource = `
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function bytes(n) {
  const hex = globalThis.__hostRandom(n);
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
/** Letters and digits; 32 by default. Safe in URLs and env files without quoting. */
export function randomPassword(length = 32) {
  return bytes(length).map((b) => alphabet[b % alphabet.length]).join("");
}
/** Lowercase letters and digits; 16 by default. */
export function randomString(length = 16) {
  const lower = "abcdefghijklmnopqrstuvwxyz0123456789";
  return bytes(length).map((b) => lower[b % lower.length]).join("");
}
/** Lowercase hex, for secrets apps expect as hex (2 characters per byte). */
export function randomHex(byteLength = 32) {
  return globalThis.__hostRandom(byteLength);
}
/** Base64 of random bytes, for keys apps expect as base64. */
export function randomBase64(byteLength = 32) {
  const b = bytes(byteLength);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + (i + 1 < b.length ? chars[(n >> 6) & 63] : "=") + (i + 2 < b.length ? chars[n & 63] : "=");
  }
  return out;
}
/** A reference to another service's variable, resolved by the panel: ref("db", "PASSWORD") -> \${{db.PASSWORD}}. */
export function ref(service, variable) {
  return "\${{" + service + "." + variable + "}}";
}
/** KEY=value lines from an object, skipping null and undefined. */
export function env(vars) {
  return Object.entries(vars).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => k + "=" + String(v)).join("\\n");
}
/** The domain the panel gives the app automatically (the node's wildcard domain). */
export const PRIMARY_DOMAIN = "$(PRIMARY_DOMAIN)";
`;
