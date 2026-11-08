// English strings: gitHosts. See ../t.ts for keys, placeholders and plurals.
// Internal git hosts: the note under a refused git source and the project's list.

export default {
  thisProject: "this project",
  note: {
    admin:
      "{host} is on an internal address: a private network, or one of this panel's nodes. The project's nodes clone it only once an admin allows it.",
    allow: "Allow this host for {project}",
    askAdmin:
      "{host} is on an internal address: a private network, or one of this panel's nodes. Only an owner or admin of this panel can allow it for {project}. Ask one of them to allow it in the project's Settings, or to save this source once.",
  },
  allow: {
    title: "Allow {host} for {project}?",
    body: "Nodes of {project} may then clone this host and port from internal addresses, their own included, never a redirect or submodule to another host. The project's members may use it in their sources too. Cloud metadata addresses stay refused.",
    confirm: "Allow host",
    done: "{host} allowed for {project}.",
  },
  list: {
    title: "Internal git hosts",
    description:
      "Git hosts this project's nodes may clone from internal addresses: a server on a private network or on one of the nodes. Saving a source as an admin adds its host when the panel sees it as internal.",
    host: "Host",
    allowedBy: "Allowed by",
    // approved_by is null both for hosts the first start of 0.2 recorded and
    // for hosts whose admin's account was deleted since (ON DELETE SET NULL).
    recorded: "Recorded on upgrade or by a removed account",
    sources: "Sources",
    usedBy: { one: "{count} source", other: "{count} sources" },
    unused: "Not used",
    remove: "Remove",
    empty: "No internal git hosts",
    emptyHint: "This project's sources clone from public addresses only.",
  },
  add: {
    label: "Allow a host",
    hint: "For a git server whose name is public at the panel but internal at the nodes, or that the panel cannot resolve. Paste a repository URL: its host and port are allowed.",
    submit: "Allow",
  },
  remove: {
    title: "Stop allowing {host}?",
    body: "Nodes of {project} then clone this host from public addresses only.",
    bodyUsed: {
      one: "{count} source in {project} clones from this host: its builds fail until an admin allows the host again.",
      other: "{count} sources in {project} clone from this host: their builds fail until an admin allows the host again.",
    },
    done: "{host} is no longer allowed.",
  },
} as const;
