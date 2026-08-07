import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("@workspace/integrations-openai-ai-server/audio", () => ({
  ensureCompatibleFormat: vi.fn(),
  speechToText: vi.fn(),
  textToSpeech: vi.fn(),
}));

import voiceRouter from "../voice";

function makeApp(authenticated: boolean): Express {
  const app = express();

  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => authenticated) as typeof req.isAuthenticated;
    req.log = { error: vi.fn() } as unknown as typeof req.log;
    next();
  });
  app.use("/api", voiceRouter);

  return app;
}

describe("voice routes authentication", () => {
  it("rejects POST /api/voice/transcribe without auth", async () => {
    const res = await request(makeApp(false)).post("/api/voice/transcribe").send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects POST /api/voice/speech without auth", async () => {
    const res = await request(makeApp(false)).post("/api/voice/speech").send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("continues to validation for authenticated transcription requests", async () => {
    const res = await request(makeApp(true)).post("/api/voice/transcribe").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Audio data is required" });
  });

  it("continues to validation for authenticated speech requests", async () => {
    const res = await request(makeApp(true))
      .post("/api/voice/speech")
      .send({ text: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Text is required" });
  });
});
