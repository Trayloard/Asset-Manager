import { useCallback } from "react";
import { useFocusEffect } from "expo-router";

/**
 * A call screen can lose focus while its provider remains mounted.
 * End recording and call timers when the user navigates away.
 */
export function useEndCallOnBlur(endCall: () => void): void {
  useFocusEffect(
    useCallback(() => {
      return () => endCall();
    }, [endCall]),
  );
}
