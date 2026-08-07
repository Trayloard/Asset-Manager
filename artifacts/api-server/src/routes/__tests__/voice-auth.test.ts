import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import crypto from "crypto";
import app from "../../app";
import { db, sessionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function makeUserId(): string {
  return `test-voice-${crypto.randomBytes(8).toString("hex")}`;
}

async function createTestUser(id: string) {
  await db
    .insert(usersTable)
    .values({ id, email: `${id}@test.local`, firstName: "Test", lastName: "User" })
    .onConflictDoNothing();
}

async function createTestSession(userId: string): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: {
      user: {
        id: userId,
        email: `${userId}@test.local`,
        firstName: "Test",
        lastName: "User",
        profileImageUrl: null,
      },
      access_token: "test-access-token",
    } as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + 60 * 60 * 1000),
  });
  return sid;
}

const createdUsers: string[] = [];
const createdSessions: string[] = [];

describe("voice routes authentication", () => {
  let sessionToken: string;

  beforeAll(async () => {
    const userId = makeUserId();
    await createTestUser(userId);
    createdUsers.push(userId);

    sessionToken = await createTestSession(userId);
    createdSessions.push(sessionToken);
  });

  afterAll(async () => {
    for (const sid of createdSessions) {
      await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
    }
    for (const id of createdUsers) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  it("rejects POST /api/voice/transcribe without auth", async () => {
    const res = await request(app).post("/api/voice/transcribe").send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects POST /api/voice/speech without auth", async () => {
    const res = await request(app).post("/api/voice/speech").send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("continues to validation for authenticated transcription requests", async () => {
    const res = await request(app)
      .post("/api/voice/transcribe")
      .set("Cookie", `sid=${sessionToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Audio data is required" });
  });

  it("continues to validation for authenticated speech requests", async () => {
    const res = await request(app)
      .post("/api/voice/speech")
      .set("Cookie", `sid=${sessionToken}`)
      .send({ text: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Text is required" });
  });
});
