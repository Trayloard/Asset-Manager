# Microphone Recovery Device Check

This checklist verifies that expo-audio releases the native microphone when the
chat is left and can acquire it again after returning. Jest tests use a mocked
recorder and cannot prove that iOS or Android released the device microphone.

## Prerequisites

- Use a signed-in native Empiri build on a physical iPhone/iPad or Android
  device. Web is not covered.
- Confirm the API server is reachable and microphone permission is granted
  before testing. Grant permission once, then return to the chat.
- Run both scenarios on each platform. Do not treat the Jest tests as a
  substitute for either device result.

## Test A — Leave while recording

| Step | Action | Expected |
|---|---|---|
| A1 | Tap the microphone and wait for the recording glow/pulse. Speak for a few seconds and confirm the glow reacts. | A recording is active and the input meter responds. |
| A2 | Send Empiri to the background (iOS: Home/app switcher; Android: Home/app switcher). Wait at least 3 seconds. | The unfinished recording is stopped and discarded; it is not sent automatically. |
| A3 | Reopen Empiri and return to the chat. | A microphone-paused notice is shown; recording has not resumed by itself. |
| A4 | Tap the microphone once, speak, and confirm the glow reacts. Tap again to stop. | A new recording starts, captures input, and stops normally. A transcription may appear if the API is reachable. |

## Test B — Leave while recorder startup is still preparing

The recording glow appears only after `prepareToRecordAsync()` has completed.
This check targets the earlier startup window.

| Step | Action | Expected |
|---|---|---|
| B1 | With permission already granted, tap the microphone and immediately send the app to the background, before the recording glow appears. | The app leaves while microphone startup is still in progress. |
| B2 | Keep Empiri in the background for at least 3 seconds, then reopen it and return to the chat. | The unfinished startup does not begin recording in the background or resume automatically. |
| B3 | Tap the microphone once, speak, and confirm the glow reacts. Tap again to stop. | A fresh recording starts and stops normally; the native microphone is available again. |

The startup window is short on some devices. If the glow appeared before the
app left the foreground, that run only covers Test A; repeat Test B until the
app is backgrounded before the glow appears. Run at least three valid B runs
per device to exercise the race consistently.

## Results

No physical iOS or Android device was available during this change, so both
platforms remain **not run** until a device owner records the results below.

| Scenario | iOS device/result | Android device/result | Notes |
|---|---|---|---|
| A — leave while recording, then record again | Not run | Not run | |
| B — leave during startup, then record again (3 valid runs) | Not run | Not run | |

## Automated regression coverage

`contexts/__tests__/CompanionContext.callLoop.test.tsx` covers the app entering
the background during recorder preparation and during an active recording. It
asserts that neither resumes automatically and that an explicit new start
records after returning to the foreground. These tests validate JavaScript
lifecycle coordination only, not native microphone ownership.
