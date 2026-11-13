// Shell-wide actions any screen can trigger: the command palette, the New
// project dialog and the New service forms. Kept in context so the sidebar,
// the dashboard, the project page and the palette open the same dialogs.
// The object menus' actions and dialogs (menus/object-actions.tsx) are
// shell-wide too.

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { ObjectActionsProvider } from "../menus/object-actions";
import { NewProjectDialog } from "../new-project-dialog";
import type { CatalogKind, NewServiceKind } from "../new-service/kinds";
import { NewServiceDialog } from "../new-service/new-service-dialog";
import { CommandPalette } from "./command-palette";

type FormKind = Exclude<NewServiceKind, CatalogKind>;

interface ShellActions {
  openPalette(): void;
  openNewProject(): void;
  /** Opens the create form for a kind; the project is asked for when not given. */
  openNewService(kind: FormKind, projectId?: string): void;
}

const ShellContext = createContext<ShellActions | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newService, setNewService] = useState<{ kind: FormKind; projectId?: string } | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const actions = useMemo<ShellActions>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openNewProject: () => setNewProjectOpen(true),
      openNewService: (kind, projectId) => setNewService({ kind, projectId }),
    }),
    [],
  );

  return (
    <ShellContext.Provider value={actions}>
      <ObjectActionsProvider>
        {children}
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
        <NewServiceDialog kind={newService?.kind ?? null} projectId={newService?.projectId} onClose={() => setNewService(null)} />
      </ObjectActionsProvider>
    </ShellContext.Provider>
  );
}

export function useShell(): ShellActions {
  const actions = useContext(ShellContext);
  if (!actions) throw new Error("useShell: render inside <ShellProvider>");
  return actions;
}
