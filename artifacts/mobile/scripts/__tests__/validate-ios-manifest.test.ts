const appConfig = require("../../app.json");
const { validateIosManifest } = require("../validate-ios-manifest");

function createManifest() {
  const expoConfig = appConfig.expo;
  return {
    extra: {
      expoClient: {
        ios: {
          bundleIdentifier: expoConfig.ios.bundleIdentifier,
          infoPlist: { ...expoConfig.ios.infoPlist },
        },
        plugins: structuredClone(expoConfig.plugins),
      },
    },
  };
}

describe("generated iOS manifest validation", () => {
  test("accepts the configured bundle identifier, plugins, and permission descriptions", () => {
    expect(() => validateIosManifest(appConfig, createManifest())).not.toThrow();
  });

  test.each([
    [
      "bundle identifier",
      (manifest: ReturnType<typeof createManifest>, missing: boolean) => {
        manifest.extra.expoClient.ios.bundleIdentifier = missing
          ? undefined
          : "com.example.changed";
      },
    ],
    [
      "configured native plugins",
      (manifest: ReturnType<typeof createManifest>, missing: boolean) => {
        manifest.extra.expoClient.plugins = missing
          ? undefined
          : [["changed-plugin", {}]];
      },
    ],
    [
      "microphone description",
      (manifest: ReturnType<typeof createManifest>, missing: boolean) => {
        manifest.extra.expoClient.ios.infoPlist.NSMicrophoneUsageDescription =
          missing ? undefined : "Changed microphone description";
      },
    ],
    [
      "motion description",
      (manifest: ReturnType<typeof createManifest>, missing: boolean) => {
        manifest.extra.expoClient.ios.infoPlist.NSMotionUsageDescription =
          missing ? undefined : "Changed motion description";
      },
    ],
  ])("rejects a missing or changed %s", (_label, alter) => {
    for (const missing of [true, false]) {
      const manifest = createManifest();
      alter(manifest, missing);
      expect(() => validateIosManifest(appConfig, manifest)).toThrow(
        "Generated iOS manifest",
      );
    }
  });
});
