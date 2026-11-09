import { integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  ownerId: varchar("owner_id").references(() => usersTable.id),
  /** Condensed summary of messages that have slid out of the context window. */
  contextSummary: text("context_summary"),
  /**
   * Number of eligible messages already summarized (after the clear boundary).
   * Used as a watermark so each refresh only processes the incremental delta.
   */
  contextSummaryMessageCount: integer("context_summary_message_count"),
  /** Messages at or below this ID must never enter a future summary. */
  contextSummaryAfterMessageId: integer("context_summary_after_message_id").notNull().default(0),
  /** Optimistic concurrency token for summaries, edits, and clears. */
  contextSummaryRevision: integer("context_summary_revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
