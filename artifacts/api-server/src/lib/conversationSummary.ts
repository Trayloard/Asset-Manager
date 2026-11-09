import { and, eq, sql } from "drizzle-orm";
import { db, conversations, type Message } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  getIncrementalMessagesForSummarisation,
  nextSummarizedCount,
  shouldRefreshSummary,
} from "./contextWindow";

/**
 * Reload memory after message insertion, rather than using the ownership-check
 * snapshot. A clear establishes a durable ID boundary; the watermark thereafter
 * counts only eligible messages. CAS prevents an in-flight model result from
 * undoing a clear/edit or a newer summary, even across server processes.
 */
export async function refreshConversationSummary(
  id: number,
  history: Message[],
  log: { error: (details: unknown, message: string) => void },
  signal?: AbortSignal,
): Promise<string | null> {
  const read = async () => {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    return row;
  };
  const current = await read();
  if (!current) return null;
  const eligible = history.filter((m) => m.id > current.contextSummaryAfterMessageId);
  const watermark = current.contextSummaryMessageCount;
  if (!signal?.aborted && shouldRefreshSummary(eligible.length, watermark)) {
    try {
      const delta = getIncrementalMessagesForSummarisation(eligible, watermark);
      const instruction = current.contextSummary
        ? `You are a memory assistant. Update the existing summary below by incorporating the new messages that follow. Keep the result to 100–150 words. Write in third person, e.g. "The user mentioned…".\n\nExisting summary:\n${current.contextSummary}`
        : `You are a memory assistant. Summarise the following conversation excerpt into a concise paragraph (100–150 words) covering the main topics discussed, any personal details the user shared, and the overall emotional tone. Write in third person, e.g. "The user mentioned…".`;
      const request = {
        model: "gpt-5-mini",
        max_completion_tokens: 512,
        messages: [
          { role: "system" as const, content: instruction },
          { role: "user" as const, content: delta.map((m) => `${m.role === "assistant" ? "Empiri" : "User"}: ${m.content}`).join("\n") },
        ],
      };
      const result = signal
        ? await openai.chat.completions.create(request, { signal })
        : await openai.chat.completions.create(request);
      const summary = result.choices[0]?.message?.content?.trim();
      if (summary && !signal?.aborted) {
        await db.update(conversations).set({
          contextSummary: summary,
          contextSummaryMessageCount: nextSummarizedCount(watermark, delta.length),
          contextSummaryRevision: sql`${conversations.contextSummaryRevision} + 1`,
        }).where(and(
          eq(conversations.id, id),
          eq(conversations.contextSummaryRevision, current.contextSummaryRevision),
        ));
      }
    } catch (err) {
      if (!signal?.aborted) {
        log.error({ err }, "Failed to refresh context summary");
      }
    }
  }
  // Never inject a rejected/stale model result into the ongoing chat reply.
  return (await read())?.contextSummary ?? null;
}
