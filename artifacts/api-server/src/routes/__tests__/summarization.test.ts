/**
 * Integration tests for the rolling context-window summarisation path.
 *
 * These tests drive the real POST /conversations/:id/messages route against
 * the real test DB.  OpenAI is mocked to return deterministic responses;
 * background self-evolution and reflection are silenced so their extra AI
 * calls do not interfere with the ordered mock sequence.
 *
 * Covered:
 *  1. shouldRefreshSummary fires when a conversation grows past CONTEXT_WINDOW_SIZE
 *  2. contextSummary and contextSummaryMessageCount are persisted in the DB
 *  3. The main chat completion call receives the summary injected as a system message
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { db, conversations, messages, sessionsTable, usersTable, companionSelves } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// OpenAI mock — hoisted so it is in place before the app module resolves.
// The route makes two ordered calls when a summary refresh fires:
//   call 1 → summarisation call  → returns the known summary text
//   call 2 → main chat reply     → returns a simple assistant message
// ---------------------------------------------------------------------------
const openaiCreateMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: openaiCreateMock } } },
}));

// Silence background self-evolution and reflection so they never trigger a
// third (or fourth) openai call that would consume the ordered mock slots.
vi.mock("../../lib/messageSignal", () => ({
  enqueueConversationTask: vi.fn(),
  queueSelfEvolution: vi.fn(),
}));
vi.mock("../../lib/reflection", () => ({
  maybeReflect: vi.fn(),
  primeReflection: vi.fn(),
  takeCachedReflection: vi.fn(),
}));

// Import the app AFTER all vi.mock() calls are hoisted.
import app from "../../app";
import { CONTEXT_WINDOW_SIZE } from "../../lib/contextWindow";

// ---------------------------------------------------------------------------
// DB helpers (same pattern as auth-ownership.test.ts)
// ---------------------------------------------------------------------------

function makeId(): string {
  return `test-summ-${crypto.randomBytes(8).toString("hex")}`;
}

async function createTestUser(id: string): Promise<void> {
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

async function createTestConversation(ownerId: string): Promise<number> {
  const [conv] = await db
    .insert(conversations)
    .values({ title: "Summarisation test", ownerId })
    .returning();
  return conv.id;
}

/** Bulk-insert `count` alternating user/assistant messages into a conversation. */
async function seedMessages(conversationId: number, count: number, prefix = "Seeded message"): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => ({
    conversationId,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `${prefix} ${i + 1}`,
  }));
  // Insert in small batches to stay under DB parameter limits.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(messages).values(rows.slice(i, i + BATCH));
  }
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

const createdUsers: string[] = [];
const createdSessions: string[] = [];
const createdConversations: number[] = [];

afterAll(async () => {
  // Messages and companion_selves are deleted implicitly by cascade when the
  // conversation row is removed (or we clean them explicitly below).
  for (const convId of createdConversations) {
    await db.delete(companionSelves).where(eq(companionSelves.conversationId, convId));
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
  }
  for (const sid of createdSessions) {
    await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  }
  for (const uid of createdUsers) {
    await db.delete(usersTable).where(eq(usersTable.id, uid));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const KNOWN_SUMMARY = "The user and Empiri discussed a wide variety of topics over many turns.";
const ASSISTANT_REPLY = "That is a great point!";

describe.each(["messages", "messages/stream"])("memory changes with %s", (endpoint) => {
  let token: string;
  let id: number;
  let uid: string;

  beforeAll(async () => {
    uid = makeId();
    await createTestUser(uid);
    createdUsers.push(uid);
    token = await createTestSession(uid);
    createdSessions.push(token);
  });

  async function setup() {
    id = await createTestConversation(uid);
    createdConversations.push(id);
    await seedMessages(id, CONTEXT_WINDOW_SIZE * 3, "FORGOTTEN");
    await db.update(conversations).set({
      contextSummary: "FORGOTTEN summary",
      contextSummaryMessageCount: 2,
    }).where(eq(conversations.id, id));
    openaiCreateMock.mockReset();
    openaiCreateMock.mockImplementation(async (args) => {
      if (args.stream) {
        return (async function* () {
          yield { choices: [{ delta: { content: ASSISTANT_REPLY }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        })();
      }
      return { choices: [{ message: { content: "NEW summary" } }] };
    });
  }

  const send = () => request(app).post(`/api/conversations/${id}/${endpoint}`)
    .set("Authorization", `Bearer ${token}`).send({ content: "NEW first message" });
  const clear = () => request(app).delete(`/api/conversations/${id}/memory`)
    .set("Authorization", `Bearer ${token}`);
  const read = async () => (await db.select().from(conversations).where(eq(conversations.id, id)))[0];
  const summaryCalls = () => openaiCreateMock.mock.calls.filter(([args]) => args.max_completion_tokens === 512);

  it("excludes all pre-clear messages, retains new overflow, and permits repeated clears", async () => {
    await setup();
    expect((await clear()).status).toBe(200);
    const boundary = (await read()).contextSummaryAfterMessageId;
    expect(boundary).toBeGreaterThan(0);
    expect((await send()).status).toBe(200);
    expect(summaryCalls()).toHaveLength(0);
    expect((await read()).contextSummary).toBeNull();

    await seedMessages(id, CONTEXT_WINDOW_SIZE, "NEW seeded");
    expect((await send()).status).toBe(200);
    expect(summaryCalls()).toHaveLength(1);
    const input = JSON.stringify(summaryCalls()[0][0].messages);
    expect(input).not.toContain("FORGOTTEN");
    expect(input).toContain("NEW first message");
    expect((await read()).contextSummaryMessageCount).toBe(3);
    expect((await read()).contextSummary).toBe("NEW summary");

    expect((await clear()).status).toBe(200);
    expect((await read()).contextSummaryAfterMessageId).toBeGreaterThan(boundary);
    openaiCreateMock.mockClear();
    expect((await send()).status).toBe(200);
    expect(summaryCalls()).toHaveLength(0);
  });

  it("preserves a manual correction made during summarisation and uses it in the pending reply", async () => {
    await setup();
    const correctedSummary = "MANUAL correction: the user lives in Hamburg, not Berlin.";
    const staleSummary = "STALE generated summary: the user lives in Berlin.";
    const before = await read();
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    openaiCreateMock.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    });

    const pending = send().then((response) => response);
    await started;
    try {
      // The model is paused with the old revision while the real edit route
      // persists a correction. No sleeps or timing assumptions are needed.
      expect(summaryCalls()).toHaveLength(1);
      const edited = await request(app).patch(`/api/conversations/${id}/memory`)
        .set("Authorization", `Bearer ${token}`)
        .send({ summary: correctedSummary });
      expect(edited.status).toBe(200);
      expect(edited.body.summary).toBe(correctedSummary);
      expect((await read()).contextSummary).toBe(correctedSummary);
    } finally {
      release({ choices: [{ message: { content: staleSummary } }] });
      await pending;
    }

    expect((await pending).status).toBe(200);
    const after = await read();
    expect(after.contextSummary).toBe(correctedSummary);
    expect(after.contextSummaryRevision).toBe(before.contextSummaryRevision + 1);
    expect(after.contextSummaryMessageCount).toBe(before.contextSummaryMessageCount);
    expect(after.contextSummaryAfterMessageId).toBe(before.contextSummaryAfterMessageId);

    expect(openaiCreateMock).toHaveBeenCalledTimes(2);
    const replyArgs = openaiCreateMock.mock.calls[1][0];
    expect(Boolean(replyArgs.stream)).toBe(endpoint === "messages/stream");
    const systemMessages = replyArgs.messages.filter(
      (message: { role: string; content: string }) => message.role === "system",
    );
    expect(systemMessages.some(
      (message: { content: string }) => message.content.includes(correctedSummary),
    )).toBe(true);
    const replyInput = JSON.stringify(replyArgs.messages);
    expect(replyInput).not.toContain(staleSummary);
    expect(replyInput).not.toContain(before.contextSummary);
  });

  it("rejects an in-flight summary after clear without losing post-clear messages", async () => {
    await setup();
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    openaiCreateMock.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = send().then((response) => response);
    await started;
    expect((await clear()).status).toBe(200);
    await seedMessages(id, CONTEXT_WINDOW_SIZE + 2, "NEW while pending");
    release({ choices: [{ message: { content: "STALE resurrected memory" } }] });
    expect((await pending).status).toBe(200);
    expect((await read()).contextSummary).toBeNull();
    expect((await read()).contextSummaryMessageCount).toBeNull();
    const replyInput = JSON.stringify(openaiCreateMock.mock.calls[1][0].messages);
    expect(replyInput).not.toContain("STALE resurrected memory");
    expect(replyInput).not.toContain("FORGOTTEN summary");

    openaiCreateMock.mockClear();
    expect((await send()).status).toBe(200);
    expect(summaryCalls()).toHaveLength(1);
    const input = JSON.stringify(summaryCalls()[0][0].messages);
    expect(input).not.toContain("FORGOTTEN");
    expect(input).toContain("NEW while pending 1");
    expect((await read()).contextSummary).toBe("NEW summary");
  });

  it("rejects an older successful summary and processes the remaining overflow on the next turn", async () => {
    id = await createTestConversation(uid);
    createdConversations.push(id);
    await seedMessages(id, CONTEXT_WINDOW_SIZE + 4);
    await db.update(conversations).set({
      contextSummary: "BASE summary",
      contextSummaryMessageCount: 2,
    }).where(eq(conversations.id, id));
    const before = await read();

    // Explicit gates keep both successful model calls in flight at the same
    // revision, with different history lengths. No timers or memory edits.
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => { resolve = done; });
      return { promise, resolve };
    }
    const olderStarted = deferred<void>();
    const newerStarted = deferred<void>();
    const olderResult = deferred<unknown>();
    const newerResult = deferred<unknown>();
    openaiCreateMock.mockReset();
    openaiCreateMock.mockImplementation(async (args) => {
      if (args.max_completion_tokens === 512) {
        const callNumber = summaryCalls().length;
        if (callNumber === 1) {
          olderStarted.resolve();
          return olderResult.promise;
        }
        if (callNumber === 2) {
          newerStarted.resolve();
          return newerResult.promise;
        }
        return { choices: [{ message: { content: "FOLLOW-UP summary" } }] };
      }
      if (args.stream) {
        return (async function* () {
          yield { choices: [{ delta: { content: ASSISTANT_REPLY }, finish_reason: null }] };
          yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        })();
      }
      return { choices: [{ message: { content: ASSISTANT_REPLY } }] };
    });

    const older = send().then((response) => response);
    let newer: typeof older | undefined;
    try {
      await olderStarted.promise;
      newer = send().then((response) => response);
      await newerStarted.promise;
      expect(summaryCalls()).toHaveLength(2);
      expect(summaryCalls()[0][0].messages[1].content.split("\n")).toHaveLength(3);
      expect(summaryCalls()[1][0].messages[1].content.split("\n")).toHaveLength(4);
      expect((await read()).contextSummaryRevision).toBe(before.contextSummaryRevision);

      // More messages arrive after both snapshots; they must remain eligible.
      await seedMessages(id, CONTEXT_WINDOW_SIZE, "PENDING");
      newerResult.resolve({ choices: [{ message: { content: "NEWER summary" } }] });
      expect((await newer).status).toBe(200);
      const winner = await read();
      expect(winner.contextSummary).toBe("NEWER summary");
      expect(winner.contextSummaryMessageCount).toBe(6);
      expect(winner.contextSummaryRevision).toBe(before.contextSummaryRevision + 1);

      olderResult.resolve({ choices: [{ message: { content: "STALE summary" } }] });
      expect((await older).status).toBe(200);
      const after = await read();
      expect(after.contextSummary).toBe(winner.contextSummary);
      expect(after.contextSummaryMessageCount).toBe(winner.contextSummaryMessageCount);
      expect(after.contextSummaryRevision).toBe(winner.contextSummaryRevision);
      expect(after.contextSummaryAfterMessageId).toBe(before.contextSummaryAfterMessageId);
      const replies = openaiCreateMock.mock.calls
        .filter(([args]) => args.max_completion_tokens !== 512);
      expect(replies).toHaveLength(2);
      for (const [args] of replies) {
        expect(JSON.stringify(args.messages)).toContain("NEWER summary");
        expect(JSON.stringify(args.messages)).not.toContain("STALE summary");
      }

      expect((await send()).status).toBe(200);
      expect(summaryCalls()).toHaveLength(3);
      const followUp = summaryCalls()[2][0].messages;
      expect(followUp[0].content).toContain("NEWER summary");
      // Resume exactly at the winning watermark, not the stale count (5).
      expect(followUp[1].content.split("\n")).toEqual([
        ...Array.from({ length: CONTEXT_WINDOW_SIZE - 2 }, (_, i) =>
          `${i % 2 === 0 ? "User" : "Empiri"}: Seeded message ${i + 7}`),
        "User: NEW first message",
        "User: NEW first message",
      ]);
      expect((await read()).contextSummaryMessageCount).toBe(46);
      expect((await read()).contextSummaryRevision).toBe(before.contextSummaryRevision + 2);
      expect((await read()).contextSummary).toBe("FOLLOW-UP summary");

      // The bounded batch leaves newer arrivals pending, not forgotten.
      expect((await send()).status).toBe(200);
      expect(summaryCalls()).toHaveLength(4);
      expect(summaryCalls()[3][0].messages[1].content).toContain("User: PENDING 1");
      expect((await read()).contextSummaryMessageCount).toBe(51);
    } finally {
      olderResult.resolve({ choices: [{ message: { content: "STALE summary" } }] });
      newerResult.resolve({ choices: [{ message: { content: "NEWER summary" } }] });
      await Promise.all([older, newer]);
    }
  });
});

describe("POST /conversations/:id/messages — context-window summarisation", () => {
  let userId: string;
  let sessionToken: string;
  let convId: number;

  beforeAll(async () => {
    userId = makeId();
    await createTestUser(userId);
    createdUsers.push(userId);

    sessionToken = await createTestSession(userId);
    createdSessions.push(sessionToken);

    convId = await createTestConversation(userId);
    createdConversations.push(convId);

    // Pre-seed exactly CONTEXT_WINDOW_SIZE messages so that the NEXT inserted
    // message (the test's user message) pushes history.length to
    // CONTEXT_WINDOW_SIZE + 1, which triggers shouldRefreshSummary.
    await seedMessages(convId, CONTEXT_WINDOW_SIZE);
  });

  it("persists contextSummary and contextSummaryMessageCount in the DB after crossing the window boundary", async () => {
    // Call 1 (summarisation): return the known summary.
    // Call 2 (main chat): return the assistant reply.
    openaiCreateMock.mockReset();
    openaiCreateMock
      .mockResolvedValueOnce({
        choices: [{ message: { content: KNOWN_SUMMARY } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: ASSISTANT_REPLY } }],
      });

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ content: "Hello, tell me something interesting." });

    expect(res.status).toBe(200);
    expect(openaiCreateMock.mock.calls.slice(0, 2).map((call) => call.length)).toEqual([1, 1]);

    // Re-fetch the conversation row to verify the DB was updated.
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId));

    expect(conv.contextSummary).toBe(KNOWN_SUMMARY);
    // watermark advances by delta.length; delta = messages[0..windowStart(41)) = 1 message
    expect(conv.contextSummaryMessageCount).toBeGreaterThan(0);
  });

  it("injects the persisted summary as a system message in the main chat completion call", async () => {
    // Fetch current state — the summary was written by the previous test.
    const [convBefore] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId));
    const existingSummary = convBefore.contextSummary!;
    expect(existingSummary).toBeTruthy();

    // Count how many messages exist now, compute the current window start, and
    // advance the watermark to that point so shouldRefreshSummary returns false
    // for this turn.  This isolates the assertion to the single main-chat call.
    const currentMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convId));
    // After the next user message is inserted, history.length = N + 1.
    const futureHistoryLen = currentMessages.length + 1;
    const futureWindowStart = Math.max(0, futureHistoryLen - CONTEXT_WINDOW_SIZE);
    await db
      .update(conversations)
      .set({ contextSummaryMessageCount: futureWindowStart })
      .where(eq(conversations.id, convId));

    openaiCreateMock.mockReset();
    openaiCreateMock.mockResolvedValue({
      choices: [{ message: { content: "Interesting thoughts!" } }],
    });

    const res = await request(app)
      .post(`/api/conversations/${convId}/messages`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ content: "Another question." });

    expect(res.status).toBe(200);

    // With summarisation suppressed there is exactly one openai call: the main
    // chat completion.  Assert that it received the existing summary injected
    // as a system message in the messages array.
    expect(openaiCreateMock).toHaveBeenCalledOnce();
    expect(openaiCreateMock.mock.calls[0]).toHaveLength(1);
    const callArgs = openaiCreateMock.mock.calls[0][0] as {
      messages: { role: string; content: string }[];
    };
    const systemMessages = callArgs.messages.filter((m) => m.role === "system");
    const summaryInjected = systemMessages.some((m) => m.content.includes(existingSummary));
    expect(summaryInjected).toBe(true);

    // Negative assertion: messages that slid out of the context window must
    // NOT appear verbatim in the exchange messages sent to the LLM.  The
    // first seeded message ("Seeded message 1") is old enough to be outside
    // the CONTEXT_WINDOW_SIZE tail, so it should be represented only by the
    // summary — not as a raw exchange message.
    const exchangeMessages = callArgs.messages.filter((m) => m.role !== "system");
    const oldMessageLeaked = exchangeMessages.some((m) => m.content === "Seeded message 1");
    expect(oldMessageLeaked).toBe(false);

    // The total exchange messages must not exceed the window size.
    expect(exchangeMessages.length).toBeLessThanOrEqual(CONTEXT_WINDOW_SIZE);
  });

  it.each(["messages", "messages/stream"])(
    "aborts a pending call-scoped reply when its client disconnects (%s)",
    async (endpoint) => {
      const cancelledConversationId = await createTestConversation(userId);
      createdConversations.push(cancelledConversationId);
      openaiCreateMock.mockReset();

      let completionSignal: AbortSignal | undefined;
      openaiCreateMock.mockImplementationOnce(
        (_params: unknown, options?: { signal?: AbortSignal }) => {
          completionSignal = options?.signal;
          return new Promise((_resolve, reject) => {
            completionSignal?.addEventListener(
              "abort",
              () => reject(new Error("request cancelled")),
              { once: true },
            );
          });
        },
      );

      const pendingRequest = request(app)
        .post(`/api/conversations/${cancelledConversationId}/${endpoint}`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .set("X-Empiri-Call-Request", "true")
        .send({ content: "Please answer this voice message." });
      const responsePromise = pendingRequest.then(
        (response) => response,
        (error) => error,
      );

      await vi.waitFor(() => expect(completionSignal).toBeDefined());
      pendingRequest.abort();
      await vi.waitFor(() => expect(completionSignal?.aborted).toBe(true));
      await responsePromise;

      const savedMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, cancelledConversationId));
      expect(savedMessages.filter((message) => message.role === "assistant")).toHaveLength(0);
      expect(openaiCreateMock).toHaveBeenCalledOnce();
      expect(openaiCreateMock.mock.calls[0][1]).toEqual({
        signal: completionSignal,
      });
    },
  );
});
