// The assistant's state for the signed-in shell: whether the bubble's chat
// is open and which chat is current. The bubble and the Assistant page
// share it, so leaving the page keeps the chat in the bubble and the other
// way round; it lives above the pages (navigation keeps it) and in this
// tab's sessionStorage (a reload keeps it), for this person only.

import { slug } from "@seylo/brand";
import { ai, auth } from "@seylo/ops";
import { useOp } from "@seylo/ops/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const assistantStorage = `${slug}.assistant`;

interface Saved {
  userId: string;
  open: boolean;
  current: string | null;
}

function readSaved(userId: string | undefined): Saved | null {
  if (!userId) return null;
  try {
    const raw = window.sessionStorage.getItem(assistantStorage);
    const saved = raw ? (JSON.parse(raw) as Partial<Saved>) : null;
    if (saved?.userId !== userId) return null;
    const current = typeof saved.current === "string" && /^[a-z0-9]{16}$/.test(saved.current) ? saved.current : null;
    return { userId, open: saved.open === true, current };
  } catch {
    return null;
  }
}

function writeSaved(saved: Saved): void {
  try {
    window.sessionStorage.setItem(assistantStorage, JSON.stringify(saved));
  } catch {
    // Storage off (private mode, blocked): the state lasts until the tab reloads.
  }
}

/** Whether the assistant is there for this person (ai.me): the bubble, the page and auto mode. */
export function useAssistantAccess() {
  const me = useOp(ai.me, {}, { retry: false, staleTime: 60_000 });
  const available = me.data?.available === true;
  return {
    query: me,
    available,
    /** The Assistant page shows in the sidebar. */
    page: available && me.data?.chatPage === true,
    autoMode: me.data?.autoMode === true,
    budgetReached: me.data?.budgetReached === true,
  };
}

interface AssistantState {
  /** The bubble's chat panel is open. */
  open: boolean;
  setOpen(open: boolean): void;
  /** The chat the bubble and the page show; null for a new, empty one. */
  current: string | null;
  select(conversationId: string | null): void;
  /** Shows a chat: on the Assistant page when it is on, else in the bubble. */
  showChat(conversationId: string | null): void;
}

const AssistantContext = createContext<AssistantState | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const viewer = useOp(auth.whoami, {});
  const userId = viewer.data?.viewer.id;
  const access = useAssistantAccess();
  const navigate = useNavigate();
  const [state, setState] = useState<Saved | null>(() => readSaved(userId));

  // Another person signed in in this tab: start from nothing.
  const fresh = (): Saved => ({ userId: userId ?? "", open: false, current: null });
  const effective: Saved = state !== null && userId && state.userId === userId ? state : fresh();
  const { open, current } = effective;
  useEffect(() => {
    if (userId) writeSaved({ userId, open, current });
  }, [userId, open, current]);

  const update = useCallback(
    (patch: Partial<Omit<Saved, "userId">>) =>
      setState((previous): Saved => {
        const base: Saved =
          previous !== null && userId && previous.userId === userId ? previous : { userId: userId ?? "", open: false, current: null };
        const next = { ...base, ...patch };
        return next.open === base.open && next.current === base.current && base === previous ? previous : next;
      }),
    [userId],
  );

  const page = access.page;
  const value = useMemo<AssistantState>(
    () => ({
      open,
      setOpen: (next) => update({ open: next }),
      current,
      select: (next) => update({ current: next }),
      showChat: (next) => {
        if (page) {
          update({ current: next, open: false });
          void navigate({ to: "/assistant", search: { c: next ?? undefined } });
        } else update({ current: next, open: true });
      },
    }),
    [open, current, update, page, navigate],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantState {
  const state = useContext(AssistantContext);
  if (!state) throw new Error("useAssistant: render inside <AssistantProvider>");
  return state;
}

/** Whether the bubble shows: the assistant is there for this person and this is not the Assistant page. */
export function useBubbleShown(): boolean {
  const { available } = useAssistantAccess();
  const onPage = useRouterState({ select: (s) => s.location.pathname === "/assistant" || s.location.pathname.startsWith("/assistant/") });
  return available && !onPage;
}
