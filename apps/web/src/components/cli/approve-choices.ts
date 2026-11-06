// What the CLI approval page (routes/cli.approve.tsx) lets people choose, and
// the cliLogin.approve input it builds. Nothing is chosen up front: the person
// picks what the key may do and which projects it reaches, so a sign-in link
// someone else sent cannot be approved with full access by pressing Approve.

export type Access = "readOnly" | "full";
export type ProjectMode = "all" | "some";

export const expiryChoices = [7, 30, 90, 365] as const;
export type ExpiryDays = (typeof expiryChoices)[number];

export type Choices = {
  access: Access | null;
  projectMode: ProjectMode | null;
  projectIds: ReadonlySet<string>;
  days: ExpiryDays;
};

export function initialChoices(): Choices {
  return { access: null, projectMode: null, projectIds: new Set(), days: 7 };
}

export type ApproveInput = {
  userCode: string;
  readOnly: boolean;
  expiresInDays: ExpiryDays;
  projectIds?: string[];
};

/** The cliLogin.approve input, or null while a choice is still missing. */
export function approveInput(userCode: string, choices: Choices): ApproveInput | null {
  if (!choices.access || !choices.projectMode) return null;
  if (choices.projectMode === "some" && choices.projectIds.size === 0) return null;
  return {
    userCode,
    readOnly: choices.access === "readOnly",
    expiresInDays: choices.days,
    ...(choices.projectMode === "some" ? { projectIds: [...choices.projectIds] } : {}),
  };
}

// "::ffff:203.0.113.5" (IPv4 seen by an IPv6 socket) and "203.0.113.5" are one address.
function plainAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice(7) : lower;
}

/**
 * True when the sign-in was started from another address than the browser
 * approving it. Unknown on either side is not a difference.
 */
export function addressDiffers(requestedFrom: string | null, viewerAddress: string | null): boolean {
  if (!requestedFrom || !viewerAddress) return false;
  return plainAddress(requestedFrom) !== plainAddress(viewerAddress);
}
