const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const archivePath = process.argv[2];

function fail(message) {
  console.error(`iOS archive validation failed: ${message}`);
  process.exit(1);
}

if (!archivePath) {
  fail("Pass the path to the generated .xcarchive as the first argument.");
}

const applicationsPath = path.join(archivePath, "Products", "Applications");
if (!fs.existsSync(applicationsPath)) {
  fail(`Archive has no Products/Applications directory: ${archivePath}`);
}

const appBundles = fs
  .readdirSync(applicationsPath)
  .filter((entry) => entry.endsWith(".app"));

if (appBundles.length !== 1) {
  fail(`Expected one app bundle in the archive, found ${appBundles.length}.`);
}

const infoPlistPath = path.join(applicationsPath, appBundles[0], "Info.plist");
if (!fs.existsSync(infoPlistPath)) {
  fail(`Archived app is missing Info.plist: ${infoPlistPath}`);
}

const appConfig = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "app.json"), "utf8"),
).expo;
const expectedValues = {
  CFBundleIdentifier: appConfig.ios?.bundleIdentifier,
  NSMicrophoneUsageDescription:
    appConfig.ios?.infoPlist?.NSMicrophoneUsageDescription,
  NSMotionUsageDescription: appConfig.ios?.infoPlist?.NSMotionUsageDescription,
};

const plistBuddy = process.env.PLIST_BUDDY || "/usr/libexec/PlistBuddy";

for (const [key, expected] of Object.entries(expectedValues)) {
  if (typeof expected !== "string" || expected.length === 0) {
    fail(`app.json is missing the configured ${key}.`);
  }

  let actual;
  try {
    actual = execFileSync(plistBuddy, ["-c", `Print :${key}`, infoPlistPath], {
      encoding: "utf8",
    }).trim();
  } catch {
    fail(`Archived Info.plist is missing ${key}.`);
  }

  if (actual !== expected) {
    fail(
      `${key} differs from app.json. Expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`,
    );
  }

  console.log(`${key}: verified`);
}

console.log(
  "Unsigned iOS archive contains the configured app identity and permissions.",
);
