// English strings: menus. The words the object menus share (the "..."
// menus and the right-click menus of services, projects, nodes and rows,
// components/menus/). Labels that already exist on a button elsewhere
// (Deploy, Restart, Clone, Hide project, ...) come from that button's
// section, so the menu and the button read the same. See ../t.ts.

export default {
  open: "Open",
  openNewTab: "Open in new tab",
  logs: "Logs",
  console: "Console",
  shell: "Shell",
  cleanup: "Cleanup",
  settings: "Settings",
  newService: "New service",
  rename: "Rename",
  delete: "Delete",
  collapse: "Collapse",
  expand: "Expand",
  viewLog: "View log",
  moveNode: "Move to another node",
  runHealthChecks: "Run health checks",
  healthChecksDone: "Health checks ran on {name}.",
  nodeOffline: "The node is offline.",
  copyAddress: "Copy address",
  copyInternalAddress: "Copy internal address",
  copyIpv4: "Copy IPv4 address",
  copyIpv6: "Copy IPv6 address",
  copyId: "Copy ID",
  copyCommit: "Copy commit SHA",
  copyDomain: "Copy domain",
  copyName: "Copy name",
  copied: "Copied to the clipboard.",
  copyFailed: "Could not copy. Select the text and copy it instead.",
  /** The accessible name of a row's right-click menu and of its "..." button. */
  actionsFor: "Actions for {name}",
  moreFor: "More actions for {name}",
  renameProject: {
    title: "Rename {name}",
    description: "The new name shows wherever the project does. Services, addresses and networks stay as they are.",
    name: "Name",
    submit: "Rename",
    done: "Project renamed.",
  },
} as const;
