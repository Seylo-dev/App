// English strings: serviceSettings. See ../t.ts for keys, placeholders and plurals.
// The Notes and Settings tabs.

export default {
  notes: {
    title: "Notes",
    description: "Markdown for the team: runbooks, links, quirks. Not secret, so keep secrets in the environment.",
    savedAt: "Saved {when}",
    edit: "Edit",
    add: "Add notes",
    cancel: "Cancel",
    rendered: "Notes",
    empty: "No notes yet",
    emptyHint: "Write a runbook, links or quirks of this service for the team.",
  },
  name: {
    title: "Name",
    description: "Also the host name other services of the project use to reach it.",
    label: "Service name",
    hint: "Lower-case letters, digits and dashes. The network alias changes on the next deploy.",
    rename: "Rename",
  },
  renamed: "Renamed. Deploy to update its network alias.",
  member: "This service belongs to a compose stack. Rename or delete it by changing the stack's compose file.",
  delete: {
    title: "Delete service",
    description: "Deletes its containers, volumes, files, domains, deploy history and kept images on every node.",
    protected: "This service runs the panel itself and cannot be deleted.",
    button: "Delete {name}",
    confirmTitle: "Delete {name}?",
    confirmBody: "Everything it stored is gone for good. Type its name to confirm.",
    confirmStack: "The stack and every member are deleted with their volumes. Type its name to confirm.",
    confirm: "Delete for good",
  },
} as const;
