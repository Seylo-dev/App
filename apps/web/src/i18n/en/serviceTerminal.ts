// English strings: serviceTerminal. See ../t.ts for keys, placeholders and plurals.
// The Console tab and the Overview's console card, in console and shell mode.

export default {
  switch: "Console or shell",
  modes: { console: "Console", shell: "Shell" },
  consoleSubtitle: "Live output of the main process. Input goes to its stdin.",
  shellSubtitle: "A new shell inside the running container.",
  openFull: "Open full",
  notRunning: "The console opens once the app runs.",
  notRunningShell: "A shell opens once the app runs.",
  /** On the Overview, for a person who may open only the shell: a shell opens when asked, never by itself. */
  openShell: "Open shell",
  noAccess: "You cannot open the console or a shell of this service. An owner or admin can give you access.",
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
  /** The console after its process exited (a restart, a deploy): it attaches to the new one by itself. */
  reconnecting: "Waiting for the new process…",
  /** The console lost its connection while the app runs: it tries again by itself (1 s, doubling to 8 s). */
  retrying: "Disconnected. Connecting again…",
  /** In place of Disconnected while nothing runs: the console connects by itself once the app starts. */
  waitNotRunning: "The app is not running. Its console connects when it starts.",
  waitStarting: "The app is starting. Its console connects when it is up.",
  /** The service's status is unknown: its node does not answer the panel. */
  waitUnknown: "The app's node is not answering. Its console connects when it is back.",
  /** After several tries while the app runs: the panel sees no container of it to attach to. */
  noContainer: "The app has no running container to attach to.",
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
