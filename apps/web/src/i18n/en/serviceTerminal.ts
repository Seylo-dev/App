// English strings: serviceTerminal. See ../t.ts for keys, placeholders and plurals.
// The Console and Shell tabs.

export default {
  switch: "Console or shell",
  consoleSubtitle: "Live output of the main process. Input goes to its stdin.",
  shellSubtitle: "A new shell inside the running container.",
  connected: "Connected to {name} (generation {generation})",
  connectedAs: "as {user}",
  connectedIn: "in {workdir}",
  connectedIdle: "ends after {idle} idle",
  where: "User and working folder",
  idleMinutes: { one: "{count} min", other: "{count} min" },
  idleSeconds: { one: "{count} s", other: "{count} s" },
  connecting: "Connecting…",
  disconnected: "Disconnected.",
  failed: "Could not open the terminal.",
  reconnect: "Reconnect",
  exited: "The process exited with code {code}.",
  search: "Search output",
  searchPlaceholder: "Find (Enter, Shift+Enter)",
  pause: "Pause output",
  resume: "Resume output",
  download: "Download output",
  clear: "Clear output",
  stdinPlaceholder: "Type a command for the app (goes to its stdin)",
  send: "Send",
} as const;
