import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetConversationResponse,
  ClearConversationResponse,
  SaveConversationMessageBody,
  SaveConversationMessageResponse,
} from "@workspace/api-zod";
import { db, conversations, messages } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const router: IRouter = Router();

const DEFAULT_TITLE = "Conversation";

export async function getOrCreateConversation(userId: string) {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(asc(conversations.createdAt))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({ userId, title: DEFAULT_TITLE })
    .returning();
  return created;
}

router.get("/conversation", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const conversation = await getOrCreateConversation(req.user.id);

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  res.json(
    GetConversationResponse.parse({
      messages: rows.map((m) => ({
        id: String(m.id),
        role: m.role,
        content: m.content,
        timestamp: m.createdAt.getTime(),
      })),
    }),
  );
});

router.post(
  "/conversation/messages",
  async (req: Request, res: Response) => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const parsed = SaveConversationMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required parameters" });
      return;
    }

    const conversation = await getOrCreateConversation(req.user.id);

    const [saved] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: parsed.data.role,
        content: parsed.data.content,
      })
      .returning();

    res.json(
      SaveConversationMessageResponse.parse({
        message: {
          id: String(saved.id),
          role: saved.role,
          content: saved.content,
          timestamp: saved.createdAt.getTime(),
        },
      }),
    );
  },
);

router.delete("/conversation", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  await db
    .delete(conversations)
    .where(eq(conversations.userId, req.user.id));

  res.json(ClearConversationResponse.parse({ success: true }));
});

export default router;
