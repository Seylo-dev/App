// English strings: invite. See ../t.ts for keys, placeholders and plurals.

export default {
  title: "You are invited",
  byWhom: "{who} invited {email} as {role}.",
  byNobody: "{email} is invited as {role}.",
  expires: "The invite expires {expires}.",
  access: "Access",
  scope: {
    project: "Project",
    service: "Service",
  },
  name: "Your name (optional)",
  createAndAccept: "Create account and accept",
  accept: "Accept invite",
  signInFirst: "{email} already has an account. Sign in with it, then accept here.",
  invalidTitle: "This invite does not work",
  invalidHint: "It was used, revoked or has expired. Ask the person who invited you for a new one.",
} as const;
