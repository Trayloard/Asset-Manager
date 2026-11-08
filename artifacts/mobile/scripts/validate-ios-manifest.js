const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const projectRoot = path.resolve(__dirname, "..");

function display(value) {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

function assertConfiguredValue(label, actual, expected) {
  if (expected === undefined || expected === null || expected === "") {
    throw new Error(`app.json is missing the configured ${label}.`);
  }

  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Generated iOS manifest ${label} does not match app.json. ` +
        `Expected ${display(expected)}; received ${display(actual)}.`,
    );
  }
}

function validateIosManifest(config, manifest) {
  const expoConfig = config?.expo;
  if (!expoConfig) {
    throw new Error("app.json is missing its expo configuration.");
  }

  const expectedBundleIdentifier = expoConfig.ios?.bundleIdentifier;
  const expectedPlugins = expoConfig.plugins;
  const expectedMicrophoneDescription =
    expoConfig.ios?.infoPlist?.NSMicrophoneUsageDescription;
  const expectedMotionDescription =
    expoConfig.ios?.infoPlist?.NSMotionUsageDescription;
  const exportedConfig = manifest?.extra?.expoClient;

  if (!Array.isArray(expectedPlugins) || expectedPlugins.length === 0) {
    throw new Error("app.json is missing its configured native plugins.");
  }

  assertConfiguredValue(
    "iOS bundle identifier",
    exportedConfig?.ios?.bundleIdentifier,
    expectedBundleIdentifier,
  );
  assertConfiguredValue(
    "configured native plugins",
    exportedConfig?.plugins,
    expectedPlugins,
  );
  assertConfiguredValue(
    "NSMicrophoneUsageDescription",
    exportedConfig?.ios?.infoPlist?.NSMicrophoneUsageDescription,
    expectedMicrophoneDescription,
  );
  assertConfiguredValue(
    "NSMotionUsageDescription",
    exportedConfig?.ios?.infoPlist?.NSMotionUsageDescription,
    expectedMotionDescription,
  );
}

function validateIosManifestFile(
  configPath = path.join(projectRoot, "app.json"),
  manifestPath = path.join(projectRoot, "static-build", "ios", "manifest.json"),
) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateIosManifest(config, manifest);
}

if (require.main === module) {
  try {
    validateIosManifestFile();
    console.log("Generated iOS manifest matches the configured iOS settings.");
  } catch (error) {
    console.error(`iOS manifest validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validateIosManifest, validateIosManifestFile };
