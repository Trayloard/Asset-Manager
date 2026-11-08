import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createConversation,
  getConversation,
  listMessages,
  sendMessage,
  synthesizeSpeech,
  transcribeAudio,
} from "@workspace/api-client-react";
import * as FileSystem from "expo-file-system/legacy";
import { AudioModule, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { AppState, type AppStateStatus } from "react-native";
import { CompanionProvider, useCompanion } from "../CompanionContext";
import { useEndCallOnBlur } from "../../hooks/useEndCallOnBlur";

/**
 * Fake-timer unit tests for the audio call loop (startCall / endCall).
 *
 * Coverage:
 *  1. isCallActive lifecycle — goes true on startCall, false on endCall.
 *  2. endCall unblocking — resolves the 20 s round promise immediately without
 *     waiting for the timeout, and the call promise itself settles.
 *  3. Round auto-stop — the 20 s timer fires, stopListening is called, and
 *     the loop starts the next round.
 *  4. Consecutive-error bail-out — after MAX_CONSECUTIVE_ERRORS (4) rounds
 *     where stopListening returns false, the loop exits on its own.
 *  5. startListening failure — when startListening cannot start recording
 *     (e.g. mic permission denied), the loop exits immediately on the first
 *     attempt without spinning or retrying.
 *
 * Recorder uri defaults to null so most stopListening calls
 * short-circuits and returns false (no audio to transcribe). This drives
 * consecutive-error counting without requiring real audio/network.
 *
 * Timer strategy: render the companion with real timers so that waitFor works
 * during setup, then switch to fake timers for the call-loop portion of each
 * test. setImmediate / nextTick / queueMicrotask are NOT faked so that
 * waitFor's internal polling continues to work.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

const mockRecorder = {
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  record: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  getStatus: jest.fn().mockReturnValue({
    canRecord: true,
    isRecording: false,
    mediaServicesDidReset: false,
    durationMillis: 0,
    metering: -30,
    url: null,
  }),
  uri: null as string | null,
};
let mockFocusedScreenCleanup: (() => void) | null = null;

jest.mock("expo-battery", () => ({
  BatteryState: { CHARGING: 2, FULL: 3 },
  getBatteryLevelAsync: jest.fn().mockResolvedValue(1),
  getBatteryStateAsync: jest.fn().mockResolvedValue(0),
  addBatteryLevelListener: jest.fn(() => ({ remove: jest.fn() })),
  addBatteryStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock("expo-sensors", () => ({
  Accelerometer: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
  },
}));

jest.mock("expo-audio", () => ({
  RecordingPresets: { HIGH_QUALITY: {}, LOW_QUALITY: {} },
  useAudioRecorder: () => mockRecorder,
  AudioModule: {
    requestRecordingPermissionsAsync: jest
      .fn()
      .mockResolvedValue({ granted: true }),
  },
  createAudioPlayer: jest.fn(),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("expo-router", () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = require("react");
    React.useEffect(() => {
      mockFocusedScreenCleanup = callback() ?? null;
      return () => {
        const cleanup = mockFocusedScreenCleanup;
        mockFocusedScreenCleanup = null;
        cleanup?.();
      };
    }, [callback]);
  },
}));

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  readAsStringAsync: jest.fn().mockResolvedValue(""),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1024 }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "test-user" },
    isLoading: false,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock("@/lib/notifications", () => ({
  cancelNudges: jest.fn().mockResolvedValue(undefined),
  requestNotificationPermission: jest.fn().mockResolvedValue(true),
  scheduleNudge: jest.fn().mockResolvedValue(undefined),
  scheduleNudgeInSeconds: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  cancelAllScheduledNotificationsAsync: jest.fn().mockResolvedValue(undefined),
  scheduleNotificationAsync: jest.fn().mockResolvedValue(undefined),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

// Shared manual mock: see artifacts/mobile/__mocks__/@workspace/api-client-react.ts
jest.mock("@workspace/api-client-react");

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockCreateConversation =
  createConversation as jest.MockedFunction<typeof createConversation>;
const mockListMessages =
  listMessages as jest.MockedFunction<typeof listMessages>;
const mockGetConversation =
  getConversation as jest.MockedFunction<typeof getConversation>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <CompanionProvider>{children}</CompanionProvider>;
}

function FocusedCallScreen() {
  const { endCall } = useCompanion();
  useEndCallOnBlur(endCall);
  return null;
}

function focusedCallWrapper({ children }: { children: React.ReactNode }) {
  return (
    <CompanionProvider>
      <FocusedCallScreen />
      {children}
    </CompanionProvider>
  );
}

/** Renders and waits until the companion has finished initializing. */
async function renderReadyCompanion() {
  const utils = renderHook(() => useCompanion(), { wrapper });
  await waitFor(() => expect(utils.result.current.initializing).toBe(false));
  return utils;
}

async function renderFocusedCompanion() {
  const utils = renderHook(() => useCompanion(), { wrapper: focusedCallWrapper });
  await waitFor(() => expect(utils.result.current.initializing).toBe(false));
  return utils;
}

function blurFocusedCallScreen() {
  const cleanup = mockFocusedScreenCleanup;
  mockFocusedScreenCleanup = null;
  cleanup?.();
}

/**
 * Advance fake timers by `ms` and flush all pending promise microtasks.
 * Must only be called after jest.useFakeTimers().
 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function captureAppStateChanges() {
  let listener: ((state: AppStateStatus) => void) | null = null;
  const addListenerSpy = jest.spyOn(AppState, "addEventListener");
  addListenerSpy.mockImplementation((_eventType, callback) => {
    listener = callback;
    return { remove: jest.fn() };
  });
  return {
    emit(state: AppStateStatus) {
      if (!listener) throw new Error("AppState listener was not registered.");
      act(() => listener?.(state));
    },
    restore() {
      addListenerSpy.mockRestore();
    },
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(async () => {
  jest.clearAllMocks();
  mockFocusedScreenCleanup = null;
  mockRecorder.uri = null;
  mockRecorder.getStatus.mockReset();
  mockRecorder.getStatus.mockReturnValue({
    canRecord: true,
    isRecording: false,
    mediaServicesDidReset: false,
    durationMillis: 0,
    metering: -30,
    url: null,
  });
  jest.mocked(sendMessage).mockReset();
  jest.mocked(transcribeAudio).mockReset();
  jest.mocked(synthesizeSpeech).mockReset();
  jest.mocked(createAudioPlayer).mockReset();
  await AsyncStorage.clear();
  mockCreateConversation.mockResolvedValue({
    id: 1,
    title: "Empiri",
    createdAt: new Date("2026-06-12T00:00:00.000Z").toISOString(),
    lastMessageText: null,
    lastMessageAt: null,
  });
  mockListMessages.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Audio call loop — cancellation during startup", () => {
  it("does not record or leave timers running when unmounted during recorder preparation", async () => {
    const { result, unmount } = await renderReadyCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let releasePrepare!: () => void;
      mockRecorder.prepareToRecordAsync.mockImplementationOnce(
        () => new Promise<void>((resolve) => { releasePrepare = resolve; }),
      );
      let callFinished = false;
      let callPromise!: Promise<void>;
      act(() => {
        callPromise = result.current.startCall().then(() => { callFinished = true; });
      });
      await tick(0);
      expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);

      act(() => { unmount(); });
      expect(jest.getTimerCount()).toBe(0);

      await act(async () => {
        releasePrepare();
        await callPromise;
      });
      expect(callFinished).toBe(true);
      expect(mockRecorder.record).not.toHaveBeenCalled();
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(setAudioModeAsync).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      expect(jest.getTimerCount()).toBe(0);
      await tick(25_000);
      expect(mockRecorder.record).not.toHaveBeenCalled();
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops an active recording and clears metering and round timers on unmount", async () => {
    const { result, unmount } = await renderReadyCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const baseline = jest.getTimerCount();
      let releaseStop!: () => void;
      mockRecorder.stop.mockImplementationOnce(
        () => new Promise<void>((resolve) => { releaseStop = resolve; }),
      );
      let callPromise!: Promise<void>;
      act(() => { callPromise = result.current.startCall(); });
      await tick(0);
      expect(result.current.isRecording).toBe(true);
      expect(jest.getTimerCount()).toBe(baseline + 2);

      act(() => { unmount(); });
      expect(jest.getTimerCount()).toBe(0);
      await tick(0);
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);

      await act(async () => {
        releaseStop();
        await callPromise;
      });
      await tick(0);
      expect(setAudioModeAsync).toHaveBeenLastCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      expect(jest.getTimerCount()).toBe(0);
      await tick(25_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("waits for an old round's delayed stop before acquiring the microphone again", async () => {
    const { result } = await renderReadyCompanion();
    jest.useFakeTimers();
    try {
      const baseline = jest.getTimerCount();
      let release!: () => void;
      mockRecorder.stop.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve;
      }));
      let oldFinished = false;
      act(() => { void result.current.startCall().then(() => { oldFinished = true; }); });
      await tick(0);
      await tick(20_000);
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("transcribing");
      act(() => {
        result.current.endCall();
        void result.current.startCall();
      });
      await tick(0);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      await act(async () => { release(); });
      await tick(0);
      expect(oldFinished).toBe(true);
      expect(mockRecorder.record).toHaveBeenCalledTimes(2);
      expect(result.current.isRecording).toBe(true);
      expect(result.current.isCallActive).toBe(true);
      expect(result.current.status).toBe("listening");
      expect(setAudioModeAsync).toHaveBeenLastCalledWith({
        allowsRecording: true, playsInSilentMode: true,
      });
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(baseline + 2);
      await tick(120);
      expect(result.current.micVolumeRef.current).toBeGreaterThan(0);
      act(() => { result.current.endCall(); });
      await tick(0);
      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(["permission", "audio mode", "prepare"] as const)(
    "never records or arms timers after hangup during %s",
    async (stage) => {
      const { result } = await renderReadyCompanion();
      jest.useFakeTimers();
      try {
        const baseline = jest.getTimerCount();
        let release!: (value?: any) => void;
        const delayed = new Promise((resolve) => { release = resolve; });
        const target = stage === "permission"
          ? jest.mocked(AudioModule.requestRecordingPermissionsAsync)
          : stage === "audio mode"
            ? jest.mocked(setAudioModeAsync)
            : mockRecorder.prepareToRecordAsync;
        target.mockImplementationOnce(() => delayed as any);
        let finished = false;
        act(() => { void result.current.startCall().then(() => { finished = true; }); });
        await tick(0);
        expect(target).toHaveBeenCalledTimes(1);
        act(() => { result.current.endCall(); });
        await act(async () => { release({ granted: true }); });
        await tick(0);
        expect(finished).toBe(true);
        expect(mockRecorder.record).not.toHaveBeenCalled();
        expect(result.current.isRecording).toBe(false);
        expect(result.current.isCallActive).toBe(false);
        expect(result.current.status).toBe("idle");
        expect(result.current.micVolumeRef.current).toBe(0);
        expect(jest.getTimerCount()).toBe(baseline);
        if (stage === "prepare") expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
        await tick(25_000);
        expect(mockRecorder.record).not.toHaveBeenCalled();
        expect(transcribeAudio).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(baseline);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each([
    ["permission", false], ["permission", true],
    ["prepare", false], ["prepare", true],
  ] as const)(
    "keeps the replacement call alive after obsolete %s settles (reject=%s)",
    async (stage, reject) => {
      const { result } = await renderReadyCompanion();
      jest.useFakeTimers();
      try {
        const baseline = jest.getTimerCount();
        let release!: (value?: any) => void;
        let fail!: (reason: Error) => void;
        const delayed = new Promise((resolve, rejectPromise) => {
          release = resolve;
          fail = rejectPromise;
        });
        const target = stage === "permission"
          ? jest.mocked(AudioModule.requestRecordingPermissionsAsync)
          : mockRecorder.prepareToRecordAsync;
        target.mockImplementationOnce(() => delayed as any);
        let oldFinished = false;
        let newFinished = false;
        act(() => { void result.current.startCall().then(() => { oldFinished = true; }); });
        await tick(0);
        act(() => {
          result.current.endCall();
          void result.current.startCall().then(() => { newFinished = true; });
        });
        await act(async () => {
          if (reject) fail(new Error("Obsolete startup failed"));
          else release({ granted: true });
        });
        await tick(0);
        expect(oldFinished).toBe(true);
        expect(newFinished).toBe(false);
        expect(mockRecorder.record).toHaveBeenCalledTimes(1);
        expect(result.current.isCallActive).toBe(true);
        expect(result.current.isRecording).toBe(true);
        expect(result.current.status).toBe("listening");
        expect(result.current.error).toBeNull();
        expect(jest.getTimerCount()).toBe(baseline + 2);
        // The surviving call owns exactly one round timer and can continue.
        await tick(20_000);
        expect(mockRecorder.record).toHaveBeenCalledTimes(2);
        expect(result.current.isCallActive).toBe(true);
        expect(jest.getTimerCount()).toBe(baseline + 2);
        act(() => { result.current.endCall(); });
        await tick(0);
        expect(newFinished).toBe(true);
        expect(result.current.isRecording).toBe(false);
        expect(jest.getTimerCount()).toBe(baseline);
      } finally {
        jest.useRealTimers();
      }
    },
  );
});

describe("Audio call loop — call screen loses focus", () => {
  it("stops an active call and clears its recorder and round timers on navigation blur", async () => {
    const { result, unmount } = await renderFocusedCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const baseline = jest.getTimerCount();
      let callPromise!: Promise<void>;
      act(() => { callPromise = result.current.startCall(); });
      await tick(0);
      expect(result.current.isRecording).toBe(true);
      expect(jest.getTimerCount()).toBe(baseline + 2);

      act(() => { blurFocusedCallScreen(); });
      await tick(0);
      await act(async () => { await callPromise; });
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.isCallActive).toBe(false);
      expect(jest.getTimerCount()).toBe(baseline);

      await tick(25_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      act(() => { blurFocusedCallScreen(); });
      unmount();
      jest.useRealTimers();
    }
  });

  it("stops standalone push-to-talk recording on navigation blur", async () => {
    const { result, unmount } = await renderFocusedCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const baseline = jest.getTimerCount();
      await act(async () => { await result.current.startListening(); });
      expect(result.current.isRecording).toBe(true);
      expect(jest.getTimerCount()).toBe(baseline + 1);

      act(() => { blurFocusedCallScreen(); });
      await tick(0);
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(result.current.isRecording).toBe(false);
      expect(jest.getTimerCount()).toBe(baseline);

      await tick(25_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(baseline);
    } finally {
      act(() => { blurFocusedCallScreen(); });
      unmount();
      jest.useRealTimers();
    }
  });
});

describe("Audio call loop — startCall / endCall", () => {
  it("does not submit a transcription that resolves after hangup, even during a new call", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    let resolveTranscription!: (value: { text: string }) => void;
    jest.mocked(transcribeAudio).mockImplementationOnce(
      () => new Promise((resolve) => { resolveTranscription = resolve; }),
    );

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      await tick(20_000);
      expect(transcribeAudio).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.endCall();
        void result.current.startCall();
      });
      await tick(0);
      expect(result.current.isCallActive).toBe(true);
      expect(result.current.isRecording).toBe(true);

      await act(async () => { resolveTranscription({ text: "old call transcript" }); });
      await tick(0);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(result.current.isCallActive).toBe(true);
      expect(result.current.isRecording).toBe(true);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("keeps manual text sends independent from a call's cancellation generation", async () => {
    const { result } = await renderReadyCompanion();
    const userMessage = {
      id: 150, conversationId: 1, role: "user" as const,
      content: "typed message", createdAt: "2026-06-12T00:00:00.000Z",
    };
    jest.mocked(sendMessage).mockResolvedValue({
      userMessage,
      assistantMessage: { ...userMessage, id: 151, role: "assistant", content: "Text reply." },
    });
    jest.mocked(synthesizeSpeech).mockResolvedValue({ audio: "audio-base64", format: "mp3" });
    let finishPlayback!: (status: { didJustFinish: boolean }) => void;
    const player = {
      play: jest.fn(),
      remove: jest.fn(),
      addListener: jest.fn((_event: string, listener: typeof finishPlayback) => {
        finishPlayback = listener;
        return { remove: jest.fn() };
      }),
    };
    jest.mocked(createAudioPlayer).mockReturnValue(
      player as unknown as ReturnType<typeof createAudioPlayer>,
    );

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      expect(result.current.isCallActive).toBe(true);

      act(() => { result.current.endCall(); });
      await tick(0);
      let sent = false;
      let sendPromise!: Promise<boolean>;
      await act(async () => {
        sendPromise = result.current.sendText("typed message");
      });
      await tick(0);
      expect(synthesizeSpeech).toHaveBeenCalledWith({ text: "Text reply." });
      await act(async () => { finishPlayback({ didJustFinish: true }); });
      await tick(0);
      sent = await sendPromise;

      expect(sent).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(1, { content: "typed message" });
      expect(result.current.messages.some((message) => message.id === 151)).toBe(true);
      expect(player.play).toHaveBeenCalledTimes(1);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("reconciles an answer that arrives after hangup as text without speaking it", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "old call transcript" });
    const oldUserMessage = {
      id: 100, conversationId: 1, role: "user" as const,
      content: "old call transcript", createdAt: "2026-06-12T00:00:00.000Z",
    };
    let resolveAnswer!: (value: Awaited<ReturnType<typeof sendMessage>>) => void;
    jest.mocked(sendMessage).mockImplementationOnce(
      () => new Promise((resolve) => { resolveAnswer = resolve; }),
    );

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      await tick(20_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("thinking");

      act(() => {
        result.current.endCall();
        void result.current.startCall();
      });
      await tick(0);
      expect(result.current.isCallActive).toBe(true);

      await act(async () => {
        resolveAnswer({
          userMessage: oldUserMessage,
          assistantMessage: {
            ...oldUserMessage,
            id: 101,
            role: "assistant",
            content: "A delayed answer.",
          },
        });
      });
      await tick(0);

      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(createAudioPlayer).not.toHaveBeenCalled();
      expect(result.current.messages).toEqual([
        oldUserMessage,
        {
          ...oldUserMessage,
          id: 101,
          role: "assistant",
          content: "A delayed answer.",
        },
      ]);
      expect(result.current.isCallActive).toBe(true);
      expect(result.current.status).toBe("listening");
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("aborts only the ended call's pending send, even when an older result settles during a newer call", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio)
      .mockResolvedValueOnce({ text: "first call transcript" })
      .mockResolvedValueOnce({ text: "second call transcript" });

    let resolveFirst!: (value: Awaited<ReturnType<typeof sendMessage>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof sendMessage>>) => void;
    let firstOptions!: RequestInit;
    let secondOptions!: RequestInit;
    jest.mocked(sendMessage)
      .mockImplementationOnce((_id, _data, options) => {
        firstOptions = options!;
        return new Promise((resolve) => { resolveFirst = resolve; });
      })
      .mockImplementationOnce((_id, _data, options) => {
        secondOptions = options!;
        return new Promise((resolve) => { resolveSecond = resolve; });
      });

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      await tick(20_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(firstOptions.headers).toEqual({
        "X-Empiri-Call-Request": "true",
      });
      expect(firstOptions.signal?.aborted).toBe(false);

      act(() => {
        result.current.endCall();
        void result.current.startCall();
      });
      await tick(0);
      expect(firstOptions.signal?.aborted).toBe(true);
      await tick(20_000);

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(secondOptions.signal?.aborted).toBe(false);

      await act(async () => {
        resolveFirst({
          userMessage: {
            id: 160, conversationId: 1, role: "user",
            content: "first call transcript", createdAt: "2026-06-12T00:00:00.000Z",
          },
          assistantMessage: {
            id: 161, conversationId: 1, role: "assistant",
            content: "Late first reply.", createdAt: "2026-06-12T00:00:01.000Z",
          },
        });
      });
      await tick(0);
      expect(secondOptions.signal?.aborted).toBe(false);

      act(() => { result.current.endCall(); });
      expect(secondOptions.signal?.aborted).toBe(true);
      await act(async () => {
        resolveSecond({
          userMessage: {
            id: 162, conversationId: 1, role: "user",
            content: "second call transcript", createdAt: "2026-06-12T00:00:02.000Z",
          },
          assistantMessage: {
            id: 163, conversationId: 1, role: "assistant",
            content: "Late second reply.", createdAt: "2026-06-12T00:00:03.000Z",
          },
        });
      });
      await tick(0);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("deduplicates a delayed answer after reopening its original chat and preserves newer message order", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "original chat transcript" });
    const oldUserMessage = {
      id: 110, conversationId: 1, role: "user" as const,
      content: "original chat transcript", createdAt: "2026-06-12T00:00:00.000Z",
    };
    const oldAssistantMessage = {
      ...oldUserMessage,
      id: 111,
      role: "assistant" as const,
      content: "A delayed answer for the original chat.",
    };
    const newerUserMessage = {
      id: 112,
      conversationId: 1,
      role: "user" as const,
      content: "A newer text message.",
      createdAt: "2026-06-12T01:00:00.000Z",
    };
    const newerAssistantMessage = {
      ...newerUserMessage,
      id: 113,
      role: "assistant" as const,
      content: "A newer text reply.",
    };
    let resolveAnswer!: (value: Awaited<ReturnType<typeof sendMessage>>) => void;
    jest.mocked(sendMessage).mockImplementationOnce(
      () => new Promise((resolve) => { resolveAnswer = resolve; }),
    );
    jest.mocked(sendMessage).mockResolvedValueOnce({
      userMessage: newerUserMessage,
      assistantMessage: newerAssistantMessage,
    });
    mockCreateConversation.mockResolvedValueOnce({
      id: 2,
      title: "Replacement chat",
      createdAt: "2026-06-12T00:00:00.000Z",
      lastMessageText: null,
      lastMessageAt: null,
    });

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      await tick(20_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      act(() => { result.current.endCall(); });
      await tick(0);
      await act(async () => { await result.current.startNewChat(); });
      expect(result.current.conversationId).toBe(2);
      expect(result.current.messages).toEqual([]);

      mockGetConversation.mockResolvedValueOnce({
        id: 1,
        title: "Empiri",
        createdAt: "2026-06-12T00:00:00.000Z",
        lastMessageText: oldAssistantMessage.content,
        lastMessageAt: oldAssistantMessage.createdAt,
      });
      mockListMessages.mockResolvedValueOnce([oldUserMessage, oldAssistantMessage]);
      await act(async () => { await result.current.openConversation(1); });
      expect(result.current.messages).toEqual([oldUserMessage, oldAssistantMessage]);

      act(() => { result.current.toggleVoice(); });
      await act(async () => {
        await result.current.sendText(newerUserMessage.content);
      });
      expect(result.current.messages).toEqual([
        oldUserMessage,
        oldAssistantMessage,
        newerUserMessage,
        newerAssistantMessage,
      ]);

      await act(async () => {
        resolveAnswer({
          userMessage: oldUserMessage,
          assistantMessage: oldAssistantMessage,
        });
      });
      await tick(0);

      expect(result.current.conversationId).toBe(1);
      expect(result.current.messages).toEqual([
        oldUserMessage,
        oldAssistantMessage,
        newerUserMessage,
        newerAssistantMessage,
      ]);
      expect(result.current.chats.find((chat) => chat.id === 1)).toMatchObject({
        lastMessageText: newerAssistantMessage.content,
        lastMessageAt: newerAssistantMessage.createdAt,
      });
      expect(synthesizeSpeech).not.toHaveBeenCalled();
      expect(createAudioPlayer).not.toHaveBeenCalled();
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("does not start playback when text-to-speech finishes after hangup", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "call transcript" });
    const userMessage = {
      id: 200, conversationId: 1, role: "user" as const,
      content: "call transcript", createdAt: "2026-06-12T00:00:00.000Z",
    };
    jest.mocked(sendMessage).mockResolvedValue({
      userMessage,
      assistantMessage: { ...userMessage, id: 201, role: "assistant", content: "A late answer." },
    });
    let resolveSpeech!: (value: { audio: string; format: string }) => void;
    jest.mocked(synthesizeSpeech).mockImplementationOnce(
      () => new Promise((resolve) => { resolveSpeech = resolve; }),
    );

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => { void result.current.startCall(); });
      await tick(0);
      await tick(20_000);
      expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
      expect(result.current.status).toBe("speaking");

      act(() => {
        result.current.endCall();
        void result.current.startCall();
      });
      await tick(0);
      await act(async () => {
        resolveSpeech({ audio: "late-audio", format: "mp3" });
      });
      await tick(0);

      expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
      expect(createAudioPlayer).not.toHaveBeenCalled();
      expect(result.current.isCallActive).toBe(true);
      expect(result.current.isRecording).toBe(true);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("stops call audio that is already playing when the user hangs up", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "call transcript" });
    const userMessage = {
      id: 300, conversationId: 1, role: "user" as const,
      content: "call transcript", createdAt: "2026-06-12T00:00:00.000Z",
    };
    jest.mocked(sendMessage).mockResolvedValue({
      userMessage,
      assistantMessage: { ...userMessage, id: 301, role: "assistant", content: "Speaking now." },
    });
    jest.mocked(synthesizeSpeech).mockResolvedValue({ audio: "audio-base64", format: "mp3" });
    let finishPlayback!: (status: { didJustFinish: boolean }) => void;
    const subscription = { remove: jest.fn() };
    const player = {
      play: jest.fn(),
      pause: jest.fn(),
      remove: jest.fn(),
      addListener: jest.fn((_event: string, listener: typeof finishPlayback) => {
        finishPlayback = listener;
        return subscription;
      }),
    };
    jest.mocked(createAudioPlayer).mockReturnValue(
      player as unknown as ReturnType<typeof createAudioPlayer>,
    );

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let callFinished = false;
      act(() => {
        void result.current.startCall().then(() => { callFinished = true; });
      });
      await tick(0);
      await tick(20_000);
      expect(player.play).toHaveBeenCalledTimes(1);
      expect(callFinished).toBe(false);

      act(() => { result.current.endCall(); });
      await tick(0);

      expect(player.pause).toHaveBeenCalledTimes(1);
      expect(player.remove).toHaveBeenCalledTimes(1);
      expect(subscription.remove).toHaveBeenCalledTimes(1);
      expect(callFinished).toBe(true);
      expect(result.current.status).toBe("idle");
      expect(result.current.isCallActive).toBe(false);
      const speechPath = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0]?.[0];
      expect(speechPath).toMatch(/^file:\/\/\/cache\/empiri-\d+\.mp3$/);
      expect(FileSystem.deleteAsync).toHaveBeenCalledWith(speechPath, { idempotent: true });
      // Keep the event handle exercised in the mock in case the completion
      // callback races with the hangup cleanup.
      expect(finishPlayback).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("resets the delivery-error streak after every successful spoken reply", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "Can you hear me?" });
    jest.mocked(synthesizeSpeech).mockResolvedValue({ audio: "audio-base64", format: "mp3" });

    let finishPlayback!: (status: { didJustFinish: boolean }) => void;
    const subscription = { remove: jest.fn() };
    const player = {
      play: jest.fn(),
      remove: jest.fn(),
      addListener: jest.fn((_event: string, listener: typeof finishPlayback) => {
        finishPlayback = listener;
        return subscription;
      }),
    };
    jest.mocked(createAudioPlayer).mockReturnValue(
      player as unknown as ReturnType<typeof createAudioPlayer>,
    );
    // Three failures, recovery, an isolated failure, recovery, then four failures.
    // The second recovery also proves resetting is not a one-time operation.
    const outcomes = [false, false, false, true, false, true, false, false, false, false];
    outcomes.forEach((success, index) => {
      if (!success) {
        jest.mocked(sendMessage).mockRejectedValueOnce(new Error("HTTP 502"));
        return;
      }
      const userMessage = {
        id: 100 + index * 2, conversationId: 1, role: "user" as const,
        content: "Can you hear me?", createdAt: "2026-06-12T00:00:00.000Z",
      };
      jest.mocked(sendMessage).mockResolvedValueOnce({
        userMessage,
        assistantMessage: { ...userMessage, id: userMessage.id + 1, role: "assistant", content: "Yes." },
      });
    });

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const baseline = jest.getTimerCount();
      let callFinished = false;
      act(() => {
        void result.current.startCall().then(() => { callFinished = true; });
      });
      await tick(0);
      let successfulRounds = 0;
      for (const [index, success] of outcomes.entries()) {
        expect(result.current.isCallActive).toBe(true);
        expect(result.current.status).toBe("listening");
        await tick(20_000);
        expect(sendMessage).toHaveBeenCalledTimes(index + 1);
        expect(transcribeAudio).toHaveBeenCalledTimes(index + 1);
        if (success) {
          successfulRounds += 1;
          expect(result.current.status).toBe("speaking");
          expect(callFinished).toBe(false);
          expect(mockRecorder.record).toHaveBeenCalledTimes(index + 1);
          expect(synthesizeSpeech).toHaveBeenLastCalledWith({ text: "Yes." });
          expect(player.play).toHaveBeenCalledTimes(successfulRounds);
          // Explicit completion avoids real audio, arbitrary delays, and the
          // best-effort speech-error fallback accidentally passing this test.
          await act(async () => { finishPlayback({ didJustFinish: true }); });
          await tick(0);
          expect(subscription.remove).toHaveBeenCalledTimes(successfulRounds);
          expect(player.remove).toHaveBeenCalledTimes(successfulRounds);
          expect(result.current.error).toBeNull();
          expect(result.current.failedTurn).toBeNull();
        }
        expect(synthesizeSpeech).toHaveBeenCalledTimes(successfulRounds);
        if (index < outcomes.length - 1) {
          expect(callFinished).toBe(false);
          expect(result.current.isCallActive).toBe(true);
          expect(result.current.isRecording).toBe(true);
          expect(result.current.status).toBe("listening");
          expect(mockRecorder.record).toHaveBeenCalledTimes(index + 2);
        }
      }
      expect(callFinished).toBe(true);
      expect(result.current.isCallActive).toBe(false);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe("idle");
      expect(mockRecorder.record).toHaveBeenCalledTimes(outcomes.length);
      expect(mockRecorder.stop).toHaveBeenCalledTimes(outcomes.length);
      expect(jest.getTimerCount()).toBe(baseline);
      await tick(100_000);
      expect(sendMessage).toHaveBeenCalledTimes(outcomes.length);
      expect(mockRecorder.record).toHaveBeenCalledTimes(outcomes.length);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("ends after four delivery failures despite successful transcription and preserves manual retry", async () => {
    const { result } = await renderReadyCompanion();
    mockRecorder.uri = "file:///cache/recording.m4a";
    jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue("a".repeat(200));
    jest.mocked(transcribeAudio).mockResolvedValue({ text: "Can you hear me?" });
    jest.mocked(sendMessage).mockRejectedValue(new Error("HTTP 502"));

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      const timersBeforeCall = jest.getTimerCount();
      let callFinished = false;
      act(() => {
        result.current.startCall().finally(() => { callFinished = true; });
      });
      await tick(0);
      for (let round = 1; round <= 4; round++) {
        expect(result.current.isRecording).toBe(true);
        expect(result.current.isCallActive).toBe(true);
        await tick(20_000);
        expect(transcribeAudio).toHaveBeenCalledTimes(round);
        expect(sendMessage).toHaveBeenCalledTimes(round);
      }

      expect(callFinished).toBe(true);
      expect(result.current.isCallActive).toBe(false);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe("idle");
      expect(result.current.micVolumeRef.current).toBe(0);
      expect(mockRecorder.record).toHaveBeenCalledTimes(4);
      expect(mockRecorder.stop).toHaveBeenCalledTimes(4);
      expect(jest.getTimerCount()).toBe(timersBeforeCall);
      expect(result.current.error).toBe("Empiri couldn't reply just now. Try again.");
      const failedTurn = result.current.failedTurn;
      expect(failedTurn?.content).toBe("Can you hear me?");
      expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(4);

      await tick(100_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(4);
      expect(sendMessage).toHaveBeenCalledTimes(4);
      expect(jest.getTimerCount()).toBe(timersBeforeCall);

      const userMessage = {
        id: 101, conversationId: 1, role: "user" as const,
        content: "Can you hear me?", createdAt: new Date().toISOString(),
      };
      jest.mocked(sendMessage).mockResolvedValue({
        userMessage,
        assistantMessage: { ...userMessage, id: 102, role: "assistant", content: "Yes." },
      });
      const countBeforeRetry = result.current.messages.length;
      await act(async () => { await result.current.retryMessage(); });
      expect(sendMessage).toHaveBeenCalledTimes(5);
      expect(result.current.error).toBeNull();
      expect(result.current.failedTurn).toBeNull();
      expect(result.current.messages.some((m) => m.id === failedTurn?.messageId)).toBe(false);
      expect(result.current.messages).toHaveLength(countBeforeRetry + 1);
      expect(mockRecorder.record).toHaveBeenCalledTimes(4);
    } finally {
      act(() => { result.current.endCall(); });
      await tick(0);
      jest.useRealTimers();
    }
  });

  it("isCallActive is true while the loop runs and false after endCall", async () => {
    // Render with real timers so waitFor works during companion init.
    const { result } = await renderReadyCompanion();

    // Switch to fake timers (keep setImmediate/nextTick real for waitFor).
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => {
        result.current.startCall();
      });
      // startListening is async; let its awaits resolve.
      await tick(0);

      await waitFor(() => expect(result.current.isCallActive).toBe(true));

      act(() => {
        result.current.endCall();
      });
      await tick(0);

      await waitFor(() => expect(result.current.isCallActive).toBe(false));
    } finally {
      jest.useRealTimers();
    }
  });

  it("endCall resolves the pending round promise immediately — no need to wait 20 s", async () => {
    const { result } = await renderReadyCompanion();

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let callFinished = false;

      act(() => {
        result.current.startCall().finally(() => {
          callFinished = true;
        });
      });
      await tick(0);

      await waitFor(() => expect(result.current.isCallActive).toBe(true));

      // Trigger endCall well before the 20 s timer would fire.
      act(() => {
        result.current.endCall();
      });
      // Flush microtasks so the loop's while condition re-evaluates and exits.
      await tick(0);

      await waitFor(() => expect(result.current.isCallActive).toBe(false));
      // The startCall() promise must have settled (finally block ran).
      await waitFor(() => expect(callFinished).toBe(true));

      // Advance past the original 20 s to confirm the timer is cancelled and
      // nothing re-starts (isCallActive stays false, no errors thrown).
      await tick(25_000);
      expect(result.current.isCallActive).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the 20 s timer fires, stopListening is called, and a new round starts", async () => {
    const { result } = await renderReadyCompanion();

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      act(() => {
        result.current.startCall();
      });

      // Wait for round 1 to reach the listening state.
      await tick(0);
      await waitFor(() => expect(result.current.status).toBe("listening"));

      // Advance 20 s → setTimeout fires → round promise resolves →
      // stopListening runs (uri=null → false, 1 consecutive error) →
      // consecutiveErrors (1) < MAX_CONSECUTIVE_ERRORS (2) → round 2 starts.
      await tick(20_000);

      // Round 2 must be listening.
      await waitFor(() => expect(result.current.status).toBe("listening"));
      expect(result.current.isCallActive).toBe(true);

      // Clean up.
      act(() => {
        result.current.endCall();
      });
      await tick(0);
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
    } finally {
      jest.useRealTimers();
    }
  });

  it("auto-exits after MAX_CONSECUTIVE_ERRORS (4) consecutive failed rounds", async () => {
    const { result } = await renderReadyCompanion();

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let callFinished = false;

      act(() => {
        result.current.startCall().finally(() => {
          callFinished = true;
        });
      });

      // Rounds 1–4: each timer fires, stopListening returns false (uri=null),
      // consecutiveErrors increments. The loop only breaks when it reaches 4.

      // Round 1.
      await tick(0);
      await waitFor(() => expect(result.current.status).toBe("listening"));
      // Round 1 timer fires → consecutiveErrors=1 (< 4, loop continues).
      await tick(20_000);

      // Round 2.
      await waitFor(() => expect(result.current.status).toBe("listening"));
      // Round 2 timer fires → consecutiveErrors=2 (< 4, loop continues).
      await tick(20_000);

      // Round 3.
      await waitFor(() => expect(result.current.status).toBe("listening"));
      // Round 3 timer fires → consecutiveErrors=3 (< 4, loop continues).
      await tick(20_000);

      // Round 4.
      await waitFor(() => expect(result.current.status).toBe("listening"));
      // Round 4 timer fires → consecutiveErrors=4 → MAX_CONSECUTIVE_ERRORS reached → loop breaks.
      await tick(20_000);

      // No endCall needed — the loop self-terminates.
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
      await waitFor(() => expect(callFinished).toBe(true));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Audio call loop — startListening failure exits immediately", () => {
  /**
   * When startListening cannot begin recording (e.g. mic permission denied,
   * native hardware error), `isRecordingRef.current` stays false. The call
   * loop detects this after awaiting startListening() and breaks immediately
   * — no 20 s round timer is armed, no second listen attempt is made, and
   * startCall() settles with isCallActive returning to false.
   *
   * We simulate the failure by making the permission check return
   * `{ granted: false }` for one call. This exercises the exact branch in
   * startListening that returns early without setting isRecordingRef.current,
   * which is the same path taken for any other failure mode (hardware error,
   * setAudioModeAsync throw, etc.).
   */

  it("exits the call loop when startListening fails on the first attempt — no retry, no hanging timer", async () => {
    const { result } = await renderReadyCompanion();

    // Deny the mic permission just for this test so startListening returns
    // early without ever setting isRecordingRef.current = true.
    (
      AudioModule.requestRecordingPermissionsAsync as jest.Mock
    ).mockResolvedValueOnce({ granted: false });

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let callFinished = false;

      act(() => {
        result.current.startCall().finally(() => {
          callFinished = true;
        });
      });

      // Flush the permission-check microtask so startListening can resolve.
      await tick(0);

      // The loop detects the failure and exits without waiting 20 s.
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
      await waitFor(() => expect(callFinished).toBe(true));

      // Status returns to idle — never stuck in "listening".
      expect(result.current.status).toBe("idle");

      // startListening was attempted exactly once — the loop did not retry.
      expect(
        AudioModule.requestRecordingPermissionsAsync,
      ).toHaveBeenCalledTimes(1);

      // No 20 s round timer was armed: advancing well past it must leave
      // everything quiet (no second startCall, no errors thrown).
      await tick(25_000);
      expect(result.current.isCallActive).toBe(false);
      // Still called only once — no extra startListening attempts fired.
      expect(
        AudioModule.requestRecordingPermissionsAsync,
      ).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("exits the call loop when startListening throws (native hardware error)", async () => {
    const { result } = await renderReadyCompanion();

    // Make the permission call itself throw — simulates a native crash inside
    // AudioModule. startListening's catch block sets status back to idle and
    // leaves isRecordingRef.current = false, so the call loop breaks.
    (
      AudioModule.requestRecordingPermissionsAsync as jest.Mock
    ).mockRejectedValueOnce(new Error("Native audio module unavailable"));

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      let callFinished = false;

      act(() => {
        result.current.startCall().finally(() => {
          callFinished = true;
        });
      });

      await tick(0);

      // The loop must exit cleanly with no uncaught rejection.
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
      await waitFor(() => expect(callFinished).toBe(true));

      expect(result.current.status).toBe("idle");
      expect(
        AudioModule.requestRecordingPermissionsAsync,
      ).toHaveBeenCalledTimes(1);

      // No timer re-fires after the failure.
      await tick(25_000);
      expect(result.current.isCallActive).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears the mic error automatically when the next startCall succeeds", async () => {
    /**
     * Scenario: permission denied on attempt 1 → error banner shown.
     * User fixes the permission and tries again. On attempt 2, recording
     * starts successfully → setError(null) fires inside startListening →
     * the error banner disappears without the user needing to dismiss it.
     */
    const { result } = await renderReadyCompanion();

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      // ── Attempt 1: permission denied ──────────────────────────────────────
      (
        AudioModule.requestRecordingPermissionsAsync as jest.Mock
      ).mockResolvedValueOnce({ granted: false });

      let call1Finished = false;
      act(() => {
        result.current.startCall().finally(() => {
          call1Finished = true;
        });
      });
      await tick(0);

      await waitFor(() => expect(call1Finished).toBe(true));
      await waitFor(() => expect(result.current.isCallActive).toBe(false));

      // The error message is shown after the first failed attempt.
      expect(result.current.error).toBe(
        "Microphone access is needed to talk to Empiri.",
      );
      expect(result.current.status).toBe("idle");

      // ── Attempt 2: permission granted (default mock) ──────────────────────
      act(() => {
        result.current.startCall();
      });
      // Flush the permission check and prepareToRecordAsync awaits.
      await tick(0);

      // Recording has started — status is "listening" and error is gone.
      await waitFor(() => expect(result.current.status).toBe("listening"));
      expect(result.current.error).toBeNull();
      expect(result.current.isCallActive).toBe(true);

      // Clean up the running call loop.
      act(() => {
        result.current.endCall();
      });
      await tick(0);
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Audio call loop — isCallActive never flashes true on a failed startListening", () => {
  /**
   * startCall used to set isCallActive=true before awaiting startListening.
   * If permission was denied, React committed a render with isCallActive=true
   * before the finally block reset it — causing the UI to briefly flash the
   * "call active" indicator even though recording never started.
   *
   * The fix: setIsCallActive(true) is deferred until after startListening
   * confirms isRecordingRef.current === true.
   *
   * This test locks that invariant in. It checks isCallActive synchronously
   * after all microtasks have flushed — if isCallActive was ever committed
   * as true, React Testing Library would reflect it here.
   */

  it("isCallActive is false throughout when permission is denied — never flashes true", async () => {
    const { result } = await renderReadyCompanion();

    (
      AudioModule.requestRecordingPermissionsAsync as jest.Mock
    ).mockResolvedValueOnce({ granted: false });

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      // Track every isCallActive value that React commits while the call
      // attempt runs. We collect values by reading the hook result after each
      // state flush — if isCallActive is ever true, the array will contain it.
      const observedCallActive: boolean[] = [];

      let callFinished = false;
      act(() => {
        result.current.startCall().finally(() => {
          callFinished = true;
        });
      });

      // Capture the state immediately after the first act flush (where the
      // old implementation would have committed isCallActive=true).
      observedCallActive.push(result.current.isCallActive);

      // Flush the permission-check microtask so startListening can resolve.
      await tick(0);
      observedCallActive.push(result.current.isCallActive);

      await waitFor(() => expect(callFinished).toBe(true));
      observedCallActive.push(result.current.isCallActive);

      // isCallActive must have been false at every observed render.
      expect(observedCallActive.every((v) => v === false)).toBe(true);
      expect(result.current.isCallActive).toBe(false);
      expect(result.current.status).toBe("idle");
    } finally {
      jest.useRealTimers();
    }
  });

  it("isCallActive becomes true only after a successful startListening", async () => {
    const { result } = await renderReadyCompanion();

    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      // isCallActive must stay false until recording starts.
      expect(result.current.isCallActive).toBe(false);

      act(() => {
        result.current.startCall();
      });

      // Before flushing microtasks (startListening hasn't resolved yet):
      // isCallActive must still be false even though startCall was called.
      expect(result.current.isCallActive).toBe(false);

      // Flush the permission check and prepareToRecordAsync — startListening
      // succeeds, recording starts, setIsCallActive(true) fires.
      await tick(0);

      await waitFor(() => expect(result.current.isCallActive).toBe(true));
      expect(result.current.status).toBe("listening");

      // Clean up.
      act(() => {
        result.current.endCall();
      });
      await tick(0);
      await waitFor(() => expect(result.current.isCallActive).toBe(false));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Microphone interruption recovery", () => {
  it("can start a fresh recording after app background interrupts recorder preparation", async () => {
    const appState = captureAppStateChanges();
    const { result, unmount } = await renderReadyCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    const timersBeforeRecording = jest.getTimerCount();

    try {
      let releasePrepare!: () => void;
      mockRecorder.prepareToRecordAsync.mockImplementationOnce(
        () => new Promise<void>((resolve) => { releasePrepare = resolve; }),
      );
      let firstStart!: Promise<void>;
      act(() => { firstStart = result.current.startListening(); });
      await tick(0);
      expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);

      appState.emit("background");
      expect(result.current.microphoneInterruption).toEqual({
        mode: "recording",
        reason: "app-state",
      });

      await act(async () => {
        releasePrepare();
        await firstStart;
      });
      await tick(0);
      expect(result.current.isRecording).toBe(false);
      expect(mockRecorder.record).not.toHaveBeenCalled();
      expect(mockRecorder.stop).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timersBeforeRecording);

      appState.emit("active");
      await act(async () => {
        await result.current.startListening();
      });
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(result.current.isRecording).toBe(true);
      expect(result.current.status).toBe("listening");
      expect(jest.getTimerCount()).toBe(timersBeforeRecording + 1);
    } finally {
      unmount();
      appState.restore();
      jest.useRealTimers();
    }
  });

  it("ends a call when the app leaves the foreground and waits for an explicit restart", async () => {
    const appState = captureAppStateChanges();
    const { result, unmount } = await renderReadyCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    const timersBeforeCall = jest.getTimerCount();

    try {
      let callFinished = false;
      act(() => {
        result.current.startCall().then(() => {
          callFinished = true;
        });
      });
      await tick(0);
      await waitFor(() => expect(result.current.isCallActive).toBe(true));
      expect(result.current.isRecording).toBe(true);

      appState.emit("background");
      await tick(0);
      await waitFor(() =>
        expect(result.current.microphoneInterruption).toEqual({
          mode: "call",
          reason: "app-state",
        }),
      );
      await waitFor(() => expect(callFinished).toBe(true));

      expect(result.current.isCallActive).toBe(false);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe("idle");
      expect(mockRecorder.stop).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timersBeforeCall);

      appState.emit("active");
      await tick(25_000);
      expect(result.current.microphoneInterruption?.mode).toBe("call");
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(timersBeforeCall);
    } finally {
      unmount();
      appState.restore();
      jest.useRealTimers();
    }
  });

  it("stops a standalone recording on app background without sending partial audio", async () => {
    const appState = captureAppStateChanges();
    const { result, unmount } = await renderReadyCompanion();
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    const timersBeforeRecording = jest.getTimerCount();

    try {
      await act(async () => {
        await result.current.startListening();
      });
      expect(result.current.isRecording).toBe(true);

      appState.emit("background");
      await tick(0);
      await waitFor(() =>
        expect(result.current.microphoneInterruption).toEqual({
          mode: "recording",
          reason: "app-state",
        }),
      );

      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe("idle");
      expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timersBeforeRecording);

      appState.emit("active");
      await tick(25_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(result.current.microphoneInterruption?.mode).toBe("recording");
      expect(jest.getTimerCount()).toBe(timersBeforeRecording);

      await act(async () => {
        await result.current.startListening();
      });
      expect(mockRecorder.record).toHaveBeenCalledTimes(2);
      expect(result.current.isRecording).toBe(true);
      expect(result.current.status).toBe("listening");
      expect(jest.getTimerCount()).toBe(timersBeforeRecording + 1);
    } finally {
      unmount();
      appState.restore();
      jest.useRealTimers();
    }
  });

  it("ends the call when the native recorder pauses during an audio interruption", async () => {
    const { result, unmount } = await renderReadyCompanion();
    mockRecorder.getStatus.mockReturnValue({
      canRecord: true,
      isRecording: true,
      mediaServicesDidReset: false,
      durationMillis: 0,
      metering: -30,
      url: null,
    });
    jest.useFakeTimers({
      doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
    });
    const timersBeforeCall = jest.getTimerCount();

    try {
      let callFinished = false;
      act(() => {
        result.current.startCall().then(() => {
          callFinished = true;
        });
      });
      await tick(0);
      await waitFor(() => expect(result.current.isCallActive).toBe(true));

      // Let the recorder confirm recording before simulating the native pause.
      await tick(120);
      mockRecorder.getStatus.mockReturnValue({
        canRecord: true,
        isRecording: false,
        mediaServicesDidReset: false,
        durationMillis: 0,
        metering: -160,
        url: null,
      });
      await tick(120);
      await waitFor(() =>
        expect(result.current.microphoneInterruption).toEqual({
          mode: "call",
          reason: "native-audio",
        }),
      );
      await waitFor(() => expect(callFinished).toBe(true));

      expect(result.current.isCallActive).toBe(false);
      expect(result.current.isRecording).toBe(false);
      expect(result.current.status).toBe("idle");
      expect(mockRecorder.stop).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timersBeforeCall);

      await tick(25_000);
      expect(mockRecorder.record).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(timersBeforeCall);
    } finally {
      unmount();
      jest.useRealTimers();
    }
  });
});
