// One chat's data for the bubble and the Assistant page: ai.conversation in
// the query cache, kept current by the live topic ai:<id>. The topic is
// followed once per chat however many views show it, and its recent events
// are logged: a fetch applies the ones that arrived while it was on the way
// (stream.ts makes that safe), so text never doubles or goes missing. A
// copy that missed something (a gap, an unknown message, a reply that
// started in another tab) refetches. Sending shows the message at once;
// stop and retry are the ai.cancel and ai.retry ops.

import { ai, OpError, type OpOutput } from "@seylo/ops";
import type { OpClient } from "@seylo/ops/client";
import { opQueryKey, useOpClient, useOpMutation } from "@seylo/ops/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { queryClient } from "../../lib/api";
import { live } from "../../lib/live";
import type { ChatContext } from "./place";
import { applyStreamEvent, applyStreamEvents, isAnswering } from "./stream";

type Conversation = OpOutput<typeof ai.conversation>;
type Message = ai.AiMessage;

interface Followed {
  count: number;
  stop: () => void;
  /** Recent events with their arrival number, for fetches that were on the way. */
  log: { seq: number; event: ai.AiStreamEvent }[];
  refetchTimer?: ReturnType<typeof setTimeout>;
}

const followed = new Map<string, Followed>();
let arrivals = 0;
/** Enough for one long reply's deltas; older ones are in any answer fetched since. */
const logSize = 600;

export function conversationKey(conversationId: string) {
  return opQueryKey(ai.conversation, { conversationId });
}

function refetchSoon(conversationId: string, entry: Followed | undefined) {
  if (!entry) return void queryClient.invalidateQueries({ queryKey: conversationKey(conversationId) });
  clearTimeout(entry.refetchTimer);
  entry.refetchTimer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: conversationKey(conversationId) }), 120);
}

function onEvent(conversationId: string, entry: Followed, event: ai.AiStreamEvent) {
  entry.log.push({ seq: ++arrivals, event });
  if (entry.log.length > logSize) entry.log.splice(0, entry.log.length - logSize);
  if (event.type === "title") {
    queryClient.setQueryData<Conversation>(conversationKey(conversationId), (old) =>
      old ? { ...old, conversation: { ...old.conversation, title: event.title } } : old,
    );
    return;
  }
  let stale = false;
  queryClient.setQueryData<Conversation>(conversationKey(conversationId), (old) => {
    if (!old) return old;
    const applied = applyStreamEvent(old.messages, event);
    stale = applied.stale;
    return applied.messages === old.messages ? old : { ...old, messages: applied.messages };
  });
  // A finished reply: refetch for what has no event (the closing note, the cost, the waiting count).
  if (stale || event.type === "done") refetchSoon(conversationId, entry);
}

/** Follows a chat's topic until the returned function is called; counted, so the bubble and the page share one. */
export function followChat(conversationId: string): () => void {
  let entry = followed.get(conversationId);
  if (!entry) {
    const created: Followed = { count: 0, stop: () => {}, log: [] };
    created.stop = live.listen(ai.aiLiveTopic(conversationId), (signal) => {
      // (Re)subscribed: whatever happened while not listening is in a fresh answer.
      if (signal.type === "subscribed") refetchSoon(conversationId, created);
      else if (signal.type === "event" && signal.event.type === "ai") onEvent(conversationId, created, signal.event.event);
    });
    followed.set(conversationId, created);
    entry = created;
  }
  const mine = entry;
  mine.count++;
  return () => {
    mine.count--;
    if (mine.count > 0) return;
    clearTimeout(mine.refetchTimer);
    mine.stop();
    followed.delete(conversationId);
  };
}

/** ai.conversation plus the events that arrived while it was fetched. */
async function fetchConversation(client: OpClient, conversationId: string, signal: AbortSignal): Promise<Conversation> {
  const from = arrivals;
  const data = await client.call(ai.conversation, { conversationId }, { signal });
  const late = (followed.get(conversationId)?.log ?? []).filter((entry) => entry.seq > from).map((entry) => entry.event);
  if (late.length === 0) return data;
  return { ...data, messages: applyStreamEvents(data.messages, late).messages };
}

/** Adds messages the cache does not have yet (an answer from ai.send or ai.retry), in order. */
function withMessages(messages: Message[], added: Message[]): Message[] {
  const known = new Set(messages.map((m) => m.id));
  return [...messages, ...added.filter((m) => !known.has(m.id))];
}

export interface Chat {
  conversation: Conversation["conversation"] | undefined;
  messages: Message[];
  /** The first answer for an existing chat is on the way. */
  loading: boolean;
  loadError: OpError | null;
  /** A reply is being written (or a message is on its way): the composer waits. */
  answering: boolean;
  /** Sends a message; resolves false when the panel refused it (sendError says why). */
  send(text: string): Promise<boolean>;
  sendError: OpError | null;
  stop(): void;
  retry(): void;
  retrying: boolean;
}

/**
 * The chat `conversationId`, or a new one (null) that `onStarted` names
 * once its first message is sent. `context` is the page a new chat starts on.
 */
/** A chat's ai.conversation (with what streamed while it was fetched); the bubble's header and the page share it. */
export function useConversation(conversationId: string | null) {
  const client = useOpClient();
  return useQuery<Conversation, OpError>({
    queryKey: conversationKey(conversationId ?? ""),
    queryFn: ({ signal }) => fetchConversation(client, conversationId ?? "", signal),
    enabled: conversationId !== null,
  });
}

export function useChat(conversationId: string | null, options: { context: ChatContext; onStarted(conversationId: string): void }): Chat {
  const { context, onStarted } = options;
  useEffect(() => (conversationId ? followChat(conversationId) : undefined), [conversationId]);
  const query = useConversation(conversationId);

  // The message on its way, shown before the panel answers.
  const [pending, setPending] = useState<{ text: string; at: string; conversationId: string | null } | null>(null);
  const [sendError, setSendError] = useState<OpError | null>(null);
  // A new chat starts empty again; an error belongs to the chat it happened in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the trigger
  useEffect(() => setSendError(null), [conversationId]);

  const sendOp = useOpMutation(ai.send);
  const cancelOp = useOpMutation(ai.cancel);
  const retryOp = useOpMutation(ai.retry);

  const send = useCallback(
    async (text: string) => {
      setSendError(null);
      setPending({ text, at: new Date().toISOString(), conversationId });
      try {
        const out = await sendOp.mutateAsync(
          conversationId ? { conversationId, message: text } : { message: text, ...(Object.keys(context).length ? { context } : {}) },
        );
        const added = [out.userMessage, out.assistantMessage];
        queryClient.setQueryData<Conversation>(conversationKey(out.conversationId), (old) =>
          old
            ? { ...old, messages: withMessages(old.messages, added) }
            : {
                conversation: {
                  id: out.conversationId,
                  title: text.replace(/\s+/g, " ").trim().slice(0, 60),
                  context,
                  costUsd: 0,
                  streaming: true,
                  pendingApprovals: 0,
                  createdAt: out.userMessage.createdAt,
                  updatedAt: out.userMessage.createdAt,
                },
                messages: added,
              },
        );
        void queryClient.invalidateQueries({ queryKey: opQueryKey(ai.conversations) });
        if (!conversationId) onStarted(out.conversationId);
        return true;
      } catch (error) {
        setSendError(error instanceof OpError ? error : new OpError("INTERNAL", "The message could not be sent."));
        return false;
      } finally {
        setPending(null);
      }
    },
    [conversationId, context, onStarted, sendOp],
  );

  const stop = useCallback(() => {
    if (conversationId) cancelOp.mutate({ conversationId });
  }, [conversationId, cancelOp]);

  const retry = useCallback(() => {
    if (!conversationId) return;
    setSendError(null);
    retryOp.mutate(
      { conversationId },
      {
        onSuccess: (out) =>
          queryClient.setQueryData<Conversation>(conversationKey(conversationId), (old) =>
            old ? { ...old, messages: withMessages(old.messages, [out.assistantMessage]) } : old,
          ),
        onError: (error) => setSendError(error),
      },
    );
  }, [conversationId, retryOp]);

  const stored = conversationId ? query.data : undefined;
  const messages = useMemo(() => {
    const list = stored?.messages ?? [];
    if (!pending || pending.conversationId !== conversationId) return list;
    const optimistic: Message = {
      id: "pending000000000",
      role: "user",
      parts: [{ type: "text", text: pending.text }],
      model: null,
      status: "done",
      error: null,
      createdAt: pending.at,
    };
    return [...list, optimistic];
  }, [stored, pending, conversationId]);

  return {
    conversation: stored?.conversation,
    messages,
    loading: conversationId !== null && query.isPending,
    loadError: conversationId !== null ? (query.error ?? null) : null,
    answering: pending !== null || isAnswering(messages) || retryOp.isPending,
    send,
    sendError,
    stop,
    retry,
    retrying: retryOp.isPending,
  };
}
