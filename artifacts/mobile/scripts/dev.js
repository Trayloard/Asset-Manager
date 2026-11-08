const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT);
const PORT_CONFLICT_RETRY_MS = 10000;
const PORT_CONFLICT_RETRY_INTERVAL_MS = 500;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Empiri's Expo preview requires a valid PORT from the artifact workflow.");
  process.exit(1);
}

function portConflictRecoveryInstructions() {
  return `The other app was left running. Identify which app owns PORT ${port}, free the port safely, then restart the Empiri workflow.`;
}

const lockKey = crypto
  .createHash("sha256")
  .update(`${projectRoot}:${port}`)
  .digest("hex")
  .slice(0, 16);
const lockDirectory = path.join(os.tmpdir(), `empiri-expo-${lockKey}.lock`);
const ownerFile = path.join(lockDirectory, "pid");
let ownsLock = false;
let stopping = false;
let child = null;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function readProcess(pid) {
  try {
    const args = fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    return {
      cwd: fs.realpathSync(`/proc/${pid}/cwd`),
      args,
      command: args.join(" "),
    };
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function isSupervisor(pid) {
  const info = readProcess(pid);
  return (
    info?.cwd === projectRoot &&
    info.command.includes("scripts/dev.js")
  );
}

function isProjectExpoProcess(pid) {
  const info = readProcess(pid);
  const portIndex = info?.args.indexOf("--port") ?? -1;
  const samePort =
    info?.args.includes(`--port=${port}`) ||
    (portIndex >= 0 && info.args[portIndex + 1] === String(port));
  return (
    info?.cwd === projectRoot &&
    info.command.includes("/expo/bin/cli") &&
    info.args.includes("start") &&
    samePort
  );
}

function projectExpoPids() {
  return fs
    .readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => isProjectExpoProcess(pid));
}

function listeningPids() {
  const result = spawnSync(
    "lsof",
    ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.error) {
    throw new Error(`Unable to inspect the Expo port: ${result.error.message}`);
  }
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`Unable to inspect listeners on PORT ${port}.`);
  }
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean))]
    .map(Number)
    .filter(Number.isInteger);
}

function probeExpo() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/status", timeout: 1500 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            healthy:
              response.statusCode === 200 &&
              body.includes("packager-status:running"),
            sameProject:
              path.resolve(
                response.headers["x-react-native-project-root"] || "",
              ) === projectRoot,
          });
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ healthy: false, sameProject: false }));
  });
}

async function acquireLock() {
  while (!stopping) {
    try {
      fs.mkdirSync(lockDirectory);
      ownsLock = true;
      fs.writeFileSync(ownerFile, String(process.pid));
      return "owned";
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    let ownerPid = 0;
    let lockAge = 0;
    try {
      const parsedOwnerPid = Number(fs.readFileSync(ownerFile, "utf8").trim());
      ownerPid =
        Number.isSafeInteger(parsedOwnerPid) && parsedOwnerPid > 0
          ? parsedOwnerPid
          : 0;
      lockAge = Date.now() - fs.statSync(lockDirectory).mtimeMs;
    } catch {
      try {
        lockAge = Date.now() - fs.statSync(lockDirectory).mtimeMs;
      } catch {
        continue;
      }
    }

    if (ownerPid && isAlive(ownerPid) && isSupervisor(ownerPid)) {
      const deadline = Date.now() + 15000;
      while (!stopping && isAlive(ownerPid) && isSupervisor(ownerPid)) {
        const status = await probeExpo();
        if (status.healthy && status.sameProject) return "observe";
        if (status.healthy) {
          throw new Error(
            `PORT ${port} serves a healthy Expo process for a different project; refusing to stop it. ${portConflictRecoveryInstructions()}`,
          );
        }
        if (Date.now() >= deadline) break;
        await sleep(500);
      }

      if (stopping) return "stopping";
      if (isAlive(ownerPid) && isSupervisor(ownerPid)) {
        const status = await probeExpo();
        if (status.healthy && status.sameProject) return "observe";
        if (status.healthy) {
          throw new Error(
            `PORT ${port} serves a healthy Expo process for a different project; refusing to stop it. ${portConflictRecoveryInstructions()}`,
          );
        }

        console.warn(
          `Stopping an unresponsive Empiri preview supervisor (pid ${ownerPid}) after PORT ${port} remained unhealthy.`,
        );
        signalProcess(ownerPid, "SIGTERM");
        for (let attempt = 0; attempt < 16; attempt += 1) {
          if (!isAlive(ownerPid) || !isSupervisor(ownerPid)) break;
          await sleep(500);
        }
        if (isAlive(ownerPid) && isSupervisor(ownerPid)) {
          signalProcess(ownerPid, "SIGKILL");
        }
      }
      continue;
    }

    // A process can be interrupted between creating the lock and writing its PID.
    if (!ownerPid && lockAge < 3000) {
      await sleep(400);
      continue;
    }

    fs.rmSync(lockDirectory, { recursive: true, force: true });
  }
  return "stopping";
}

function releaseLock() {
  if (!ownsLock) return;
  try {
    const ownerPid = Number(fs.readFileSync(ownerFile, "utf8").trim());
    if (ownerPid === process.pid) {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  } catch {
    // The lock may already have been removed by stale-lock recovery.
  }
  ownsLock = false;
}

process.on("exit", releaseLock);

async function clearStaleListener(pid) {
  async function inspectOwnership() {
    const status = await probeExpo();
    if (status.healthy && status.sameProject) return "reuse";
    if (status.healthy) return "conflict";

    const currentListeners = listeningPids();
    if (currentListeners.length === 0) return "free";
    if (currentListeners.some((currentPid) => currentPid !== pid)) {
      return "conflict";
    }
    if (!isProjectExpoProcess(pid)) {
      return "conflict";
    }
    return "stale";
  }

  // Give a just-started Metro process time to finish its health endpoint.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ownership = await inspectOwnership();
    if (ownership !== "stale") return ownership;
    await sleep(500);
  }

  // Recheck health and the listener PID immediately before signaling. The
  // process that was stale at the start of recovery may no longer own PORT.
  const ownershipBeforeTerm = await inspectOwnership();
  if (ownershipBeforeTerm !== "stale") return ownershipBeforeTerm;

  console.warn(
    `Stopping an unresponsive Empiri Expo process (pid ${pid}) on PORT ${port}.`,
  );
  signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ownership = await inspectOwnership();
    if (ownership !== "stale") return ownership;
    await sleep(250);
  }

  // Never escalate based only on the original PID: ownership may have changed
  // while the graceful shutdown window was running.
  const ownershipBeforeKill = await inspectOwnership();
  if (ownershipBeforeKill !== "stale") return ownershipBeforeKill;
  signalProcess(pid, "SIGKILL");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ownership = await inspectOwnership();
    if (ownership !== "stale") return ownership;
    await sleep(250);
  }
  throw new Error(`The stale Empiri Expo listener on PORT ${port} did not exit.`);
}

async function inspectPort() {
  let pids = listeningPids();
  if (pids.length === 0) {
    await clearUnboundLaunchers();
    pids = listeningPids();
  }
  if (pids.length === 0) return "free";

  const status = await probeExpo();
  if (status.healthy && status.sameProject) {
    await clearDuplicateLaunchers(pids);
    return "reuse";
  }
  if (status.healthy) return "conflict";

  for (const pid of pids) {
    if (!isProjectExpoProcess(pid)) return "conflict";
    const result = await clearStaleListener(pid);
    if (result === "reuse") return result;
    if (result === "conflict") return result;
  }
  return "free";
}

async function clearUnboundLaunchers() {
  const deadline = Date.now() + 10000;
  while (!stopping && Date.now() < deadline) {
    if (listeningPids().length > 0) return;
    if (projectExpoPids().length === 0) return;
    await sleep(500);
  }

  for (const pid of projectExpoPids()) {
    if (listeningPids().includes(pid) || !isProjectExpoProcess(pid)) continue;
    console.warn(
      `Stopping a duplicate Empiri Expo launcher (pid ${pid}) that never opened PORT ${port}.`,
    );
    signalProcess(pid, "SIGTERM");
    for (let attempt = 0; attempt < 20 && isAlive(pid); attempt += 1) {
      if (!isProjectExpoProcess(pid) || listeningPids().includes(pid)) break;
      await sleep(250);
    }
    if (isAlive(pid) && isProjectExpoProcess(pid) && !listeningPids().includes(pid)) {
      signalProcess(pid, "SIGKILL");
    }
  }
}

async function clearDuplicateLaunchers(listenerPids) {
  for (const pid of projectExpoPids()) {
    if (listenerPids.includes(pid) || !isProjectExpoProcess(pid)) continue;
    console.warn(
      `Stopping duplicate Empiri Expo launcher (pid ${pid}); healthy Metro on PORT ${port} is left running.`,
    );
    signalProcess(pid, "SIGTERM");
    for (let attempt = 0; attempt < 20 && isAlive(pid); attempt += 1) {
      if (!isProjectExpoProcess(pid)) break;
      await sleep(250);
    }
    if (isAlive(pid) && isProjectExpoProcess(pid)) {
      signalProcess(pid, "SIGKILL");
    }
  }
}

function checkExpoCompatibility() {
  let expoCli;
  try {
    expoCli = require.resolve("expo/bin/cli", { paths: [projectRoot] });
  } catch (error) {
    throw new Error(
      `Unable to find the local Expo CLI needed to check dependency compatibility: ${error.message}`,
    );
  }

  const result = spawnSync(
    process.execPath,
    [expoCli, "install", "--check"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(
      `Unable to run the Expo dependency compatibility check: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      "Expo dependency compatibility check failed; Empiri preview startup was stopped. " +
        "From artifacts/mobile, run `pnpm exec expo install --fix`, then retry the preview.",
    );
  }
  return expoCli;
}

async function waitForReusedServer() {
  await clearDuplicateLaunchers(listeningPids());
  console.log(
    `Empiri Metro is already healthy on PORT ${port}; reusing it without stopping it.`,
  );
  while (!stopping) {
    const status = await probeExpo();
    if (status.healthy && status.sameProject) {
      await sleep(1000);
      continue;
    }
    return;
  }
}

function startExpo() {
  const expoCli = checkExpoCompatibility();
  const env = {
    ...process.env,
    EXPO_PACKAGER_PROXY_URL: `https://${process.env.REPLIT_EXPO_DEV_DOMAIN || ""}`,
    EXPO_PUBLIC_DOMAIN: process.env.REPLIT_DEV_DOMAIN || "",
    EXPO_PUBLIC_REPL_ID: process.env.REPL_ID || "",
    REACT_NATIVE_PACKAGER_HOSTNAME: process.env.REPLIT_DEV_DOMAIN || "",
  };

  console.log(`Starting Empiri Expo on workflow PORT ${port}.`);
  child = spawn(
    process.execPath,
    [expoCli, "start", "--localhost", "--port", String(port)],
    { cwd: projectRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  return new Promise((resolve, reject) => {
    let forceKillTimer;
    const onStop = (signal) => {
      if (!child || child.exitCode !== null) return;
      child.kill(signal);
      forceKillTimer = setTimeout(() => {
        if (child && child.exitCode === null) child.kill("SIGKILL");
      }, 8000);
      forceKillTimer.unref();
    };

    const onTerm = () => onStop("SIGTERM");
    const onInt = () => onStop("SIGINT");
    process.once("SIGTERM", onTerm);
    process.once("SIGINT", onInt);

    child.once("error", (error) => {
      clearTimeout(forceKillTimer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      child = null;
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(forceKillTimer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      child = null;
      resolve({ code, signal });
    });
  });
}

async function main() {
  let lockStatus = await acquireLock();
  while (lockStatus === "observe" && !stopping) {
    await waitForReusedServer();
    if (stopping) return 0;
    lockStatus = await acquireLock();
  }
  if (lockStatus !== "owned") return 0;

  let conflictDeadline = null;
  while (!stopping) {
    const portState = await inspectPort();
    if (portState === "conflict") {
      if (conflictDeadline === null) {
        conflictDeadline = Date.now() + PORT_CONFLICT_RETRY_MS;
        console.warn(
          `PORT ${port} is occupied by another process; retrying for up to ${PORT_CONFLICT_RETRY_MS}ms without stopping it. ${portConflictRecoveryInstructions()}`,
        );
      }
      if (Date.now() >= conflictDeadline) {
        throw new Error(
          `PORT ${port} remained occupied by another process; refusing to stop it. ${portConflictRecoveryInstructions()}`,
        );
      }
      await sleep(
        Math.min(
          PORT_CONFLICT_RETRY_INTERVAL_MS,
          conflictDeadline - Date.now(),
        ),
      );
      continue;
    }
    conflictDeadline = null;
    if (portState === "reuse") {
      await waitForReusedServer();
      continue;
    }
    if (stopping) break;

    const result = await startExpo();
    if (stopping) break;

    const stateAfterExit = await inspectPort();
    if (stateAfterExit === "reuse") continue;
    if (stateAfterExit === "conflict") continue;

    console.error(
      `Expo exited before serving Empiri on PORT ${port} (exit ${result.code ?? result.signal}).`,
    );
    return result.code && result.code > 0 ? result.code : 1;
  }
  return 0;
}

process.on("SIGTERM", () => {
  stopping = true;
  if (child && child.exitCode === null) child.kill("SIGTERM");
});
process.on("SIGINT", () => {
  stopping = true;
  if (child && child.exitCode === null) child.kill("SIGINT");
});

main()
  .then((code) => {
    releaseLock();
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error.message);
    releaseLock();
    process.exitCode = 1;
  });
