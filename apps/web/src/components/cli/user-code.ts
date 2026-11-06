// The CLI sign-in's user code ("ABCD-EFGH", cliLogin.UserCode): what people
// type is cleaned up so "abcd efgh" or "abcdefgh" finds the request too.

import { cliLogin } from "@seylo/ops";

const pattern = new RegExp(cliLogin.UserCode.pattern ?? "^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$");

/** The code in its canonical form, or null when it cannot be one. */
export function normalizeUserCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (letters.length !== 8) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return pattern.test(code) ? code : null;
}
