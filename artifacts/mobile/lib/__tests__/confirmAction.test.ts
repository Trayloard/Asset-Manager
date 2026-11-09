import { Alert, Platform } from "react-native";
import { confirmAction } from "../confirmAction";

describe("web confirmations", () => {
  const os = Platform.OS;
  const originalConfirm = window.confirm;
  afterEach(() => {
    Platform.OS = os;
    window.confirm = originalConfirm;
    jest.restoreAllMocks();
  });
  it.each(["Sign out?", "Delete this chat?"])("%s only runs after approval", (title) => {
    Platform.OS = "web";
    const confirm = jest.fn().mockReturnValue(false);
    window.confirm = confirm;
    const alert = jest.spyOn(Alert, "alert");
    const action = jest.fn();
    confirmAction(title, "Confirm action", "Continue", action);
    expect(action).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    confirmAction(title, "Confirm action", "Continue", action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });
});
