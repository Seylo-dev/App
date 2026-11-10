// English strings: settingsProfile. See ../t.ts for keys, placeholders and plurals.
//
// Settings > Personal details: the signed-in person's avatar, name and email.

export default {
  title: "Personal details",
  subtitle: "Your avatar, your name and the email you sign in with.",
  avatar: {
    title: "Avatar",
    description: "Shown next to your name in the sidebar, People, Activity and Approvals.",
    yours: "Your avatar",
    upload: "Upload image",
    uploadAnother: "Upload another",
    uploadHint: "PNG, JPEG or WebP. The middle square is used.",
    remove: "Remove image",
    uploaded: "Avatar updated",
    removed: "Image removed. Your generated avatar is back.",
    picked: "Avatar updated",
    problems: {
      type: "Pick a PNG, JPEG or WebP image.",
      tooBig: "That image is too large. Try a smaller one.",
      unreadable: "Could not read that image.",
    },
    generated: "Generated avatars",
    generatedHint: "Pick one, or roll new ones.",
    style: "Style",
    randomize: "Randomize",
    use: "Use this avatar",
    drawnBy: "{work} by {creator}, {license}. Drawn by the panel with DiceBear.",
  },
  profile: {
    title: "Profile",
    name: "Name",
    email: "Email",
    emailHint: "You sign in with it. Changing it asks you to confirm it's you.",
    saved: "Saved",
    emailChanged: "Email changed",
    emailChangedNotified: "Email changed. Your old address got a note about it.",
  },
} as const;
