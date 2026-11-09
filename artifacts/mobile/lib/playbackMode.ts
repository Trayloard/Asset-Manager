import { setAudioModeAsync } from "expo-audio";

/** Best-effort reset shared by normal recording stop and call cancellation. */
export function restorePlaybackMode(): void {
  void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
}
