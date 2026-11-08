// What Add node may say about Docker for the join command. The command
// always runs the install host's installer, which is the latest stable
// release's, also on a pre-release panel (the panel's
// modules/nodes/join-command.ts). Installers install a missing Docker by
// themselves since 0.2.1. A 0.2.1 pre-release panel's command therefore
// still runs the 0.2.0 installer, which asks first and stops when there is
// no terminal. Once no 0.2.1 pre-release panel runs, this can go.

/** The first release whose installer installs a missing Docker without asking. */
const dockerInstallSince = [0, 2, 1] as const;

/** Whether the join command of a panel on `panelVersion` installs a missing Docker without asking. */
export function joinInstallsDocker(panelVersion: string): boolean {
  // Releases, and dev builds (which cannot tell), take the installer's word.
  const match = /^v?(\d+)\.(\d+)\.(\d+)-/.exec(panelVersion.trim());
  if (!match) return true;
  const base = match.slice(1, 4).map(Number);
  for (const [i, since] of dockerInstallSince.entries()) {
    const part = base[i] ?? 0;
    if (part !== since) return part > since;
  }
  // A pre-release of 0.2.1: the latest stable installer is older.
  return false;
}
