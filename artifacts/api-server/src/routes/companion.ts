import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCompanionSettingsResponse,
  UpdateCompanionSettingsBody,
  UpdateCompanionSettingsResponse,
} from "@workspace/api-zod";
import { db, companionSettings } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  DEFAULT_COMPANION_NAME,
  DEFAULT_COMPANION_TONE,
} from "../lib/companionPrompt";

const router: IRouter = Router();

export async function getOrCreateCompanionSettings(userId: string) {
  const [existing] = await db
    .select()
    .from(companionSettings)
    .where(eq(companionSettings.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(companionSettings)
    .values({
      userId,
      name: DEFAULT_COMPANION_NAME,
      tone: DEFAULT_COMPANION_TONE,
    })
    .onConflictDoNothing({
      target: companionSettings.userId,
    })
    .returning();
  if (created) return created;

  const [winner] = await db
    .select()
    .from(companionSettings)
    .where(eq(companionSettings.userId, userId))
    .limit(1);
  if (!winner) {
    throw new Error(`Failed to resolve companion settings for user ${userId}`);
  }
  return winner;
}

router.get("/companion-settings", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const settings = await getOrCreateCompanionSettings(req.user.id);

  res.json(
    GetCompanionSettingsResponse.parse({
      settings: {
        name: settings.name,
        tone: settings.tone,
        personalityNote: settings.personalityNote ?? null,
      },
    }),
  );
});

router.put("/companion-settings", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = UpdateCompanionSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required parameters" });
    return;
  }

  const name = parsed.data.name.trim() || DEFAULT_COMPANION_NAME;
  const personalityNote = parsed.data.personalityNote?.trim() || null;

  const [saved] = await db
    .insert(companionSettings)
    .values({
      userId: req.user.id,
      name,
      tone: parsed.data.tone,
      personalityNote,
    })
    .onConflictDoUpdate({
      target: companionSettings.userId,
      set: {
        name,
        tone: parsed.data.tone,
        personalityNote,
      },
    })
    .returning();

  res.json(
    UpdateCompanionSettingsResponse.parse({
      settings: {
        name: saved!.name,
        tone: saved!.tone,
        personalityNote: saved!.personalityNote ?? null,
      },
    }),
  );
});

export default router;
