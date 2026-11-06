// Types for the "~templates-utils" module that templates import. The real
// module lives in the panel's sandbox (apps/panel/src/template-runner/utils.ts).

declare module "~templates-utils" {
  /** Letters and digits; 32 by default. */
  export function randomPassword(length?: number): string;
  /** Lowercase letters and digits; 16 by default. */
  export function randomString(length?: number): string;
  /** Hex of random bytes (2 characters per byte); 32 bytes by default. */
  export function randomHex(byteLength?: number): string;
  /** Base64 of random bytes; 32 bytes by default. */
  export function randomBase64(byteLength?: number): string;
  /** A ${{service.VARIABLE}} reference the panel resolves on every deploy. */
  export function ref(service: string, variable: string): string;
  /** KEY=value lines; null and undefined values are left out. */
  export function env(vars: Record<string, string | number | boolean | null | undefined>): string;
  /** The node's automatic domain. */
  export const PRIMARY_DOMAIN: string;
}
