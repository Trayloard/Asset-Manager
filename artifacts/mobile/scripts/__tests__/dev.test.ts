import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Server } from "node:net";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const mobileRoot = path.resolve(__dirname, "../..");
const launcherPath = path.join(mobileRoot, "scripts/dev.js");
const activeChildren = new Set<ChildProcessWithoutNullStreams>();
const fixtureDirectories = new Set<string>();

function withFakeExpoCompatibilityCheck(
  source: string,
  options: { exitCode?: number; message?: string } = {},
): string {
  const { exitCode = 0, message = "FAKE_EXPO_COMPATIBILITY_CHECK_PASSED" } =
    options;
  return [
    'if (process.argv[2] === "install" && process.argv[3] === "--check") {',
    `  console.log(${JSON.stringify(message)});`,
    `  process.exit(${exitCode});`,
    "}",
    source,
  ].join("\n");
}

function getLauncherLockDirectory(projectRoot: string, port: number): string {
  const lockKey = crypto
    .createHash("sha256")
    .update(`${projectRoot}:${port}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `empiri-expo-${lockKey}.lock`);
}

function spawnTracked(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, options);
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}

function captureOutput(child: ChildProcessWithoutNullStreams): () => string {
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

async function waitForOutput(
  child: ChildProcess,
  getOutput: () => string,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = getOutput();
    if (pattern.test(output)) return output;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Process exited before output matched ${pattern}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern}:\n${getOutput()}`);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 3000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Process ${child.pid} did not exit in time`)),
      timeoutMs,
    );
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopProcess(child: ChildProcess | null | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 2500);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 2500);
  }
}

async function getEphemeralPort(): Promise<number> {
  const server: Server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startStatusServer(
  port: number,
  projectRoot: string,
  statusCode = 200,
  body = "packager-status:running",
): ChildProcessWithoutNullStreams {
  const source = [
    'const http = require("node:http");',
    "const [port, root, status, body] = process.argv.slice(1);",
    "const server = http.createServer((req, res) => {",
    '  res.writeHead(Number(status), { "x-react-native-project-root": root });',
    "  res.end(body);",
    "});",
    'server.listen(Number(port), "127.0.0.1", () => console.log("READY"));',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  ].join("\n");
  return spawnTracked(
    process.execPath,
    ["-e", source, String(port), projectRoot, String(statusCode), body],
    { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

function startLauncher(
  port: number,
  options: {
    projectRoot?: string;
    scriptPath?: string;
    env?: Record<string, string>;
  } = {},
): { child: ChildProcessWithoutNullStreams; getOutput: () => string } {
  const child = spawnTracked(
    process.execPath,
    [options.scriptPath ?? launcherPath],
    {
      cwd: options.projectRoot ?? mobileRoot,
      env: { ...process.env, ...options.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { child, getOutput: captureOutput(child) };
}

function getHttpResponse(port: number, requestPath = "/status"): Promise<{
  statusCode: number | undefined;
  body: string;
  projectRoot: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: requestPath, timeout: 1000 },
      (response: IncomingMessage) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        response.on("end", () => {
          const rootHeader =
            response.headers["x-react-native-project-root"];
          resolve({
            statusCode: response.statusCode,
            body,
            projectRoot: Array.isArray(rootHeader) ? rootHeader[0] : rootHeader,
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
  });
}

afterEach(async () => {
  await Promise.all([...activeChildren].map((child) => stopProcess(child)));
  for (const directory of fixtureDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  fixtureDirectories.clear();
});

describe("Expo preview launcher port-conflict recovery", () => {
  test("stops before Metro startup when Expo dependencies are incompatible", async () => {
    const port = await getEphemeralPort();
    const fixtureDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), `empiri-launcher-incompatible-${process.pid}-`),
    );
    fixtureDirectories.add(fixtureDirectory);
    const projectRoot = path.join(fixtureDirectory, "mobile");
    const fixtureLauncherPath = path.join(projectRoot, "scripts", "dev.js");
    const fakeExpoCli = path.join(
      projectRoot,
      "node_modules",
      "expo",
      "bin",
      "cli",
    );
    fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
    fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
    fs.copyFileSync(launcherPath, fixtureLauncherPath);
    fs.writeFileSync(
      fakeExpoCli,
      withFakeExpoCompatibilityCheck(
        'console.log("FAKE_EXPO_START_UNEXPECTED");',
        {
          exitCode: 1,
          message: "FAKE_EXPO_DEPENDENCY_MISMATCH",
        },
      ),
    );

    const { child: launcher, getOutput } = startLauncher(port, {
      projectRoot,
      scriptPath: fixtureLauncherPath,
    });
    const result = await waitForExit(launcher);

    expect(result.code).toBe(1);
    expect(getOutput()).toContain("FAKE_EXPO_DEPENDENCY_MISMATCH");
    expect(getOutput()).toContain(
      "Expo dependency compatibility check failed; Empiri preview startup was stopped.",
    );
    expect(getOutput()).toContain("pnpm exec expo install --fix");
    expect(getOutput()).not.toContain("Starting Empiri Expo");
    expect(getOutput()).not.toContain("FAKE_EXPO_START_UNEXPECTED");
  });

  test(
    "starts a healthy Expo preview after clearing an aged ownerless launcher lock",
    async () => {
      const port = await getEphemeralPort();
      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-recovery-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(projectRoot, "scripts", "dev.js");
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const http = require("node:http");',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  res.writeHead(200, { "x-react-native-project-root": process.cwd() });',
          '  res.end("packager-status:running");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log("FAKE_EXPO_READY"));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const lockDirectory = getLauncherLockDirectory(projectRoot, port);
      fixtureDirectories.add(lockDirectory);
      fs.mkdirSync(lockDirectory);
      const staleTime = new Date(Date.now() - 10000);
      fs.utimesSync(lockDirectory, staleTime, staleTime);

      const { child: launcher, getOutput } = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
      });
      try {
        await waitForOutput(launcher, getOutput, /FAKE_EXPO_READY/, 10000);

        expect(getOutput()).toContain(`Starting Empiri Expo on workflow PORT ${port}`);
        expect(fs.readFileSync(path.join(lockDirectory, "pid"), "utf8")).toBe(
          String(launcher.pid),
        );
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot,
        });
      } finally {
        await stopProcess(launcher);
      }

      expect(fs.existsSync(lockDirectory)).toBe(false);
      await expect(getHttpResponse(port)).rejects.toThrow();
    },
    15000,
  );

  test(
    "coordinates simultaneous launchers and hands the preview to the survivor",
    async () => {
      const port = await getEphemeralPort();
      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-concurrent-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(projectRoot, "scripts", "dev.js");
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      const runCountPath = path.join(fixtureDirectory, "expo-run-count");
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(runCountPath, "0");
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const fs = require("node:fs");',
          'const http = require("node:http");',
          "const runCountPath = process.env.EMPIRI_FIXTURE_RUN_COUNT;",
          'const runCount = Number(fs.readFileSync(runCountPath, "utf8")) + 1;',
          'fs.writeFileSync(runCountPath, String(runCount));',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  res.writeHead(200, { "x-react-native-project-root": process.cwd() });',
          '  res.end("packager-status:running");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log(`FAKE_EXPO_READY_${runCount}`));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const lockDirectory = getLauncherLockDirectory(projectRoot, port);
      fixtureDirectories.add(lockDirectory);
      const fixtureEnv = { EMPIRI_FIXTURE_RUN_COUNT: runCountPath };
      const first = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
        env: fixtureEnv,
      });
      const second = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
        env: fixtureEnv,
      });
      const launchers = [first, second];
      let owner: (typeof first) | undefined;
      let observer: (typeof first) | undefined;

      try {
        const ownerFile = path.join(lockDirectory, "pid");
        const lockDeadline = Date.now() + 5000;
        while (!fs.existsSync(ownerFile) && Date.now() < lockDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const lockOwnerPid = Number(fs.readFileSync(ownerFile, "utf8").trim());
        owner = launchers.find(({ child }) => child.pid === lockOwnerPid);
        observer = launchers.find(({ child }) => child.pid !== lockOwnerPid);
        expect(owner).toBeDefined();
        expect(observer).toBeDefined();

        await Promise.all([
          waitForOutput(
            owner!.child,
            owner!.getOutput,
            /FAKE_EXPO_READY_1/,
            12000,
          ),
          waitForOutput(
            observer!.child,
            observer!.getOutput,
            /reusing it without stopping it/,
            12000,
          ),
        ]);
        expect(fs.readFileSync(runCountPath, "utf8")).toBe("1");
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot,
        });

        // Stopping a launcher that only observes Metro must not stop its owner.
        await stopProcess(observer?.child);
        expect(owner?.child.exitCode).toBeNull();
        expect(fs.readFileSync(runCountPath, "utf8")).toBe("1");
        expect((await getHttpResponse(port)).body).toBe(
          "packager-status:running",
        );

        // Put another launcher in place before stopping the owner. It should
        // acquire the released lock and restore the preview rather than leave
        // the workflow without a supervisor.
        const survivor = startLauncher(port, {
          projectRoot,
          scriptPath: fixtureLauncherPath,
          env: fixtureEnv,
        });
        try {
          await waitForOutput(
            survivor.child,
            survivor.getOutput,
            /reusing it without stopping it/,
            12000,
          );
          await stopProcess(owner?.child);
          await waitForOutput(
            survivor.child,
            survivor.getOutput,
            /FAKE_EXPO_READY_2/,
            12000,
          );
          expect(fs.readFileSync(runCountPath, "utf8")).toBe("2");
          expect(survivor.child.exitCode).toBeNull();
          expect(await getHttpResponse(port)).toMatchObject({
            statusCode: 200,
            body: "packager-status:running",
            projectRoot,
          });
        } finally {
          await stopProcess(survivor.child);
        }

        expect(fs.existsSync(lockDirectory)).toBe(false);
        await expect(getHttpResponse(port)).rejects.toThrow();
      } finally {
        await Promise.all(launchers.map(({ child }) => stopProcess(child)));
      }
    },
    30000,
  );

  test(
    "reuses a healthy Metro server for this project without terminating it",
    async () => {
      const port = await getEphemeralPort();
      const metro = startStatusServer(port, mobileRoot);
      const metroOutput = captureOutput(metro);
      await waitForOutput(metro, metroOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port);
      const output = await waitForOutput(launcher, getOutput, /reusing it without stopping it/);

      expect(output).toContain(`PORT ${port}`);
      expect(launcher.exitCode).toBeNull();
      expect(metro.exitCode).toBeNull();
      expect((await getHttpResponse(port)).body).toBe("packager-status:running");

      await stopProcess(launcher);

      expect(metro.exitCode).toBeNull();
      expect((await getHttpResponse(port)).body).toBe("packager-status:running");
    },
    12000,
  );

  test(
    "starts a fake replacement when a reused same-project server exits",
    async () => {
      const port = await getEphemeralPort();
      let unrelatedPort = await getEphemeralPort();
      while (unrelatedPort === port) {
        unrelatedPort = await getEphemeralPort();
      }

      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-reused-exit-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(
        projectRoot,
        "scripts",
        "dev.js",
      );
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      const runCountPath = path.join(fixtureDirectory, "expo-run-count");
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(runCountPath, "0");
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const fs = require("node:fs");',
          'const http = require("node:http");',
          "const runCountPath = process.env.EMPIRI_FIXTURE_RUN_COUNT;",
          'const runCount = Number(fs.readFileSync(runCountPath, "utf8")) + 1;',
          'fs.writeFileSync(runCountPath, String(runCount));',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  res.writeHead(200, { "x-react-native-project-root": process.cwd() });',
          '  res.end("packager-status:running");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log("FAKE_EXPO_REPLACEMENT_READY"));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const lockDirectory = getLauncherLockDirectory(projectRoot, port);
      fixtureDirectories.add(lockDirectory);
      const reusedMetro = startStatusServer(port, projectRoot);
      const reusedMetroOutput = captureOutput(reusedMetro);
      await waitForOutput(reusedMetro, reusedMetroOutput, /READY/);
      expect(await getHttpResponse(port)).toMatchObject({
        statusCode: 200,
        body: "packager-status:running",
        projectRoot,
      });

      const unrelatedProjectRoot = path.join(
        fixtureDirectory,
        "unrelated-project",
      );
      const unrelatedProcess = startStatusServer(
        unrelatedPort,
        unrelatedProjectRoot,
      );
      const unrelatedOutput = captureOutput(unrelatedProcess);
      await waitForOutput(unrelatedProcess, unrelatedOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
        env: { EMPIRI_FIXTURE_RUN_COUNT: runCountPath },
      });
      try {
        const reuseOutput = await waitForOutput(
          launcher,
          getOutput,
          /reusing it without stopping it/,
        );
        expect(reuseOutput).toContain(`PORT ${port}`);
        expect(reusedMetro.exitCode).toBeNull();
        expect(fs.readFileSync(runCountPath, "utf8")).toBe("0");

        await stopProcess(reusedMetro);
        await waitForOutput(
          launcher,
          getOutput,
          /FAKE_EXPO_REPLACEMENT_READY/,
          10000,
        );

        expect(fs.readFileSync(runCountPath, "utf8")).toBe("1");
        expect(getOutput()).not.toContain(
          "Stopping an unresponsive Empiri Expo process",
        );
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot,
        });
        expect(launcher.exitCode).toBeNull();
        expect(unrelatedProcess.exitCode).toBeNull();
        expect(await getHttpResponse(unrelatedPort)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot: unrelatedProjectRoot,
        });
      } finally {
        await stopProcess(launcher);
      }
    },
    20000,
  );

  test(
    "starts Empiri after a temporary listener releases the preview port",
    async () => {
      const port = await getEphemeralPort();
      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-port-release-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(projectRoot, "scripts", "dev.js");
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const http = require("node:http");',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  res.writeHead(200, { "x-react-native-project-root": process.cwd() });',
          '  res.end("packager-status:running");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log("FAKE_EXPO_READY"));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const lockDirectory = getLauncherLockDirectory(projectRoot, port);
      fixtureDirectories.add(lockDirectory);
      const otherProjectRoot = path.join(
        os.tmpdir(),
        `temporary-port-owner-${process.pid}-${port}`,
      );
      const listener = startStatusServer(port, otherProjectRoot, 503, "busy");
      const listenerOutput = captureOutput(listener);
      await waitForOutput(listener, listenerOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
      });
      try {
        await waitForOutput(
          launcher,
          getOutput,
          /retrying for up to \d+ms without stopping it/,
        );
        expect(getOutput()).toContain(
          `The other app was left running. Identify which app owns PORT ${port}, free the port safely, then restart the Empiri workflow.`,
        );
        expect(listener.exitCode).toBeNull();
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 503,
          body: "busy",
          projectRoot: otherProjectRoot,
        });
        expect(getOutput()).not.toContain("Starting Empiri Expo");

        await stopProcess(listener);
        await waitForOutput(launcher, getOutput, /FAKE_EXPO_READY/, 10000);

        expect(getOutput()).toContain(
          `Starting Empiri Expo on workflow PORT ${port}`,
        );
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot,
        });
        expect(launcher.exitCode).toBeNull();
      } finally {
        await stopProcess(launcher);
        await stopProcess(listener);
      }
    },
    20000,
  );

  test(
    "gives up after a bounded wait without signaling a foreign preview listener",
    async () => {
      const port = await getEphemeralPort();
      const otherProjectRoot = path.join(
        os.tmpdir(),
        `unrelated-expo-${process.pid}-${port}`,
      );
      const listener = startStatusServer(port, otherProjectRoot);
      const listenerOutput = captureOutput(listener);
      await waitForOutput(listener, listenerOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port);
      try {
        await waitForOutput(
          launcher,
          getOutput,
          /retrying for up to 10000ms without stopping it/,
        );
        const result = await waitForExit(launcher, 12000);

        expect(result.code).toBe(1);
        expect(getOutput()).toContain(
          `PORT ${port} remained occupied by another process; refusing to stop it.`,
        );
        expect(getOutput()).toContain(
          `The other app was left running. Identify which app owns PORT ${port}, free the port safely, then restart the Empiri workflow.`,
        );
        expect(getOutput()).not.toContain("Starting Empiri Expo");
        expect(listener.exitCode).toBeNull();
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot: otherProjectRoot,
        });
      } finally {
        await stopProcess(launcher);
        await stopProcess(listener);
      }
    },
    15000,
  );

  test(
    "clears an aged malformed-owner lock but refuses to stop a healthy unrelated listener",
    async () => {
      const port = await getEphemeralPort();
      const lockDirectory = getLauncherLockDirectory(mobileRoot, port);
      fixtureDirectories.add(lockDirectory);
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(path.join(lockDirectory, "pid"), "not-a-pid\n");
      const staleTime = new Date(Date.now() - 10000);
      fs.utimesSync(lockDirectory, staleTime, staleTime);

      const otherProjectRoot = path.join(
        os.tmpdir(),
        `unrelated-expo-${process.pid}-${port}`,
      );
      const listener = startStatusServer(port, otherProjectRoot);
      const listenerOutput = captureOutput(listener);
      await waitForOutput(listener, listenerOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port);
      try {
        await waitForOutput(
          launcher,
          getOutput,
          /retrying for up to 10000ms without stopping it/,
        );
        const result = await waitForExit(launcher, 12000);

        expect(result.code).toBe(1);
        expect(getOutput()).toContain(
          `PORT ${port} remained occupied by another process; refusing to stop it.`,
        );
        expect(getOutput()).toContain(
          `The other app was left running. Identify which app owns PORT ${port}, free the port safely, then restart the Empiri workflow.`,
        );
        expect(getOutput()).not.toContain("Starting Empiri Expo");
        expect(fs.existsSync(lockDirectory)).toBe(false);
        expect(listener.exitCode).toBeNull();
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot: otherProjectRoot,
        });
      } finally {
        await stopProcess(launcher);
        await stopProcess(listener);
      }
    },
    16000,
  );

  test(
    "cleans up an unhealthy same-project Expo process only after its grace period",
    async () => {
      const port = await getEphemeralPort();
      const fixtureDirectory = fs.mkdtempSync(
        path.join(mobileRoot, ".port-conflict-test-"),
      );
      fixtureDirectories.add(fixtureDirectory);
      const fakeExpoCli = path.join(fixtureDirectory, "expo", "bin", "cli");
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const http = require("node:http");',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  res.writeHead(503, { "x-react-native-project-root": process.cwd() });',
          '  res.end("packager-status:starting");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log("STALE_READY"));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const staleProcess = spawnTracked(
        process.execPath,
        [fakeExpoCli, "start", "--port", String(port)],
        { cwd: mobileRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const staleOutput = captureOutput(staleProcess);
      await waitForOutput(staleProcess, staleOutput, /STALE_READY/);

      const startedAt = Date.now();
      const { child: launcher, getOutput } = startLauncher(port);
      await waitForOutput(
        launcher,
        getOutput,
        /Stopping an unresponsive Empiri Expo process/,
        12000,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(5000);

      // Stop the launcher while it finishes cleaning the stale listener so it
      // cannot start a real Metro server after the test port becomes free.
      await stopProcess(launcher);
      await waitForExit(staleProcess, 3000);

      expect(getOutput()).toContain(`PORT ${port}`);
      expect(staleProcess.exitCode).not.toBeNull();
    },
    20000,
  );

  test(
    "does not signal a stale launcher after another project takes over its port",
    async () => {
      const port = await getEphemeralPort();
      let controlPort = await getEphemeralPort();
      while (controlPort === port) {
        controlPort = await getEphemeralPort();
      }

      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-takeover-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(
        projectRoot,
        "scripts",
        "dev.js",
      );
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(
        fakeExpoCli,
        [
          'const http = require("node:http");',
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const controlPort = Number(process.argv[portIndex + 2]);",
          "let statusRequests = 0;",
          "let pendingStatus;",
          "const server = http.createServer((req, res) => {",
          '  if (req.url === "/status") {',
          "    statusRequests += 1;",
          "    if (statusRequests === 14) {",
          '      console.log("FINAL_STATUS_PENDING");',
          "      pendingStatus = res;",
          "      return;",
          "    }",
          '    res.writeHead(503, { "x-react-native-project-root": process.cwd() });',
          '    res.end("packager-status:starting");',
          "    return;",
          "  }",
          '  res.writeHead(404);',
          "  res.end();",
          "});",
          "const control = http.createServer((req, res) => {",
          '  if (req.url === "/handoff") {',
          "    server.close();",
          '    res.end("handoff");',
          "    return;",
          "  }",
          '  if (req.url === "/finish") {',
          '    pendingStatus.end("packager-status:starting");',
          '    res.end("finished");',
          "    return;",
          "  }",
          "  res.writeHead(404);",
          "  res.end();",
          "});",
          'server.listen(port, "127.0.0.1", () => console.log("STALE_READY"));',
          'control.listen(controlPort, "127.0.0.1");',
          'process.on("SIGTERM", () => console.log("STALE_SIGTERM"));',
        ].join("\n"),
      );

      const staleProcess = spawnTracked(
        process.execPath,
        [fakeExpoCli, "start", "--port", String(port), String(controlPort)],
        { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const staleOutput = captureOutput(staleProcess);
      await waitForOutput(staleProcess, staleOutput, /STALE_READY/);

      const { child: launcher, getOutput } = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
      });
      let otherProject: ChildProcessWithoutNullStreams | null = null;
      try {
        await waitForOutput(
          staleProcess,
          staleOutput,
          /FINAL_STATUS_PENDING/,
          12000,
        );

        await getHttpResponse(controlPort, "/handoff");
        const otherProjectRoot = path.join(
          fixtureDirectory,
          "different-project",
        );
        otherProject = startStatusServer(port, otherProjectRoot);
        const otherProjectOutput = captureOutput(otherProject);
        await waitForOutput(otherProject, otherProjectOutput, /READY/);
        await getHttpResponse(controlPort, "/finish");

        await waitForOutput(
          launcher,
          getOutput,
          /retrying for up to 10000ms without stopping it/,
        );
        const result = await waitForExit(launcher, 12000);
        expect(result.code).toBe(1);
        expect(getOutput()).toContain(
          `PORT ${port} remained occupied by another process; refusing to stop it.`,
        );
        expect(getOutput()).not.toContain("Starting Empiri Expo");
        expect(getOutput()).not.toContain(
          "Stopping an unresponsive Empiri Expo process",
        );
        expect(staleOutput()).not.toContain("STALE_SIGTERM");
        expect(staleProcess.exitCode).toBeNull();
        expect(otherProject.exitCode).toBeNull();
        expect(await getHttpResponse(port)).toMatchObject({
          statusCode: 200,
          body: "packager-status:running",
          projectRoot: otherProjectRoot,
        });
      } finally {
        await stopProcess(launcher);
        await stopProcess(staleProcess);
        await stopProcess(otherProject);
      }
    },
    40000,
  );

  test(
    "restarts with healthy Metro after a reused same-project server becomes unhealthy",
    async () => {
      const port = await getEphemeralPort();
      let unrelatedPort = await getEphemeralPort();
      while (unrelatedPort === port) {
        unrelatedPort = await getEphemeralPort();
      }

      const fixtureDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), `empiri-launcher-test-${process.pid}-`),
      );
      fixtureDirectories.add(fixtureDirectory);
      const projectRoot = path.join(fixtureDirectory, "mobile");
      const fixtureLauncherPath = path.join(
        projectRoot,
        "scripts",
        "dev.js",
      );
      const fakeExpoCli = path.join(
        projectRoot,
        "node_modules",
        "expo",
        "bin",
        "cli",
      );
      const runCountPath = path.join(fixtureDirectory, "expo-run-count");
      fs.mkdirSync(path.dirname(fixtureLauncherPath), { recursive: true });
      fs.mkdirSync(path.dirname(fakeExpoCli), { recursive: true });
      fs.copyFileSync(launcherPath, fixtureLauncherPath);
      fs.writeFileSync(runCountPath, "0");
      fs.writeFileSync(
        fakeExpoCli,
        withFakeExpoCompatibilityCheck([
          'const fs = require("node:fs");',
          'const http = require("node:http");',
          "const runCountPath = process.env.EMPIRI_FIXTURE_RUN_COUNT;",
          "const runCount = Number(fs.readFileSync(runCountPath, \"utf8\")) + 1;",
          "fs.writeFileSync(runCountPath, String(runCount));",
          "let healthy = true;",
          'const portIndex = process.argv.indexOf("--port");',
          "const port = Number(process.argv[portIndex + 1]);",
          "const server = http.createServer((req, res) => {",
          '  if (req.url === "/make-unhealthy") {',
          "    healthy = false;",
          "    res.writeHead(204);",
          "    res.end();",
          "    return;",
          "  }",
          '  res.writeHead(healthy ? 200 : 503, { "x-react-native-project-root": process.cwd() });',
          '  res.end(healthy ? "packager-status:running" : "packager-status:starting");',
          "});",
          'server.listen(port, "127.0.0.1", () => console.log(`FAKE_EXPO_READY_${runCount}`));',
          'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
        ].join("\n")),
      );

      const fixtureEnv = { EMPIRI_FIXTURE_RUN_COUNT: runCountPath };
      const reusedMetro = spawnTracked(
        process.execPath,
        [fakeExpoCli, "start", "--port", String(port)],
        {
          cwd: projectRoot,
          env: { ...process.env, ...fixtureEnv },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const metroOutput = captureOutput(reusedMetro);
      await waitForOutput(reusedMetro, metroOutput, /FAKE_EXPO_READY_1/);
      expect(await getHttpResponse(port)).toMatchObject({
        statusCode: 200,
        body: "packager-status:running",
        projectRoot,
      });

      const unrelatedProcess = startStatusServer(
        unrelatedPort,
        path.join(os.tmpdir(), `unrelated-expo-${process.pid}`),
      );
      const unrelatedOutput = captureOutput(unrelatedProcess);
      await waitForOutput(unrelatedProcess, unrelatedOutput, /READY/);

      const { child: launcher, getOutput } = startLauncher(port, {
        projectRoot,
        scriptPath: fixtureLauncherPath,
        env: fixtureEnv,
      });
      const reuseOutput = await waitForOutput(
        launcher,
        getOutput,
        /reusing it without stopping it/,
      );
      expect(reuseOutput).toContain(`PORT ${port}`);
      expect(reusedMetro.exitCode).toBeNull();

      await getHttpResponse(port, "/make-unhealthy");
      const unhealthyAt = Date.now();
      expect(await getHttpResponse(port)).toMatchObject({
        statusCode: 503,
        body: "packager-status:starting",
      });

      await new Promise((resolve) => setTimeout(resolve, 1250));
      expect(reusedMetro.exitCode).toBeNull();
      expect(getOutput()).not.toContain(
        "Stopping an unresponsive Empiri Expo process",
      );
      expect((await getHttpResponse(port)).statusCode).toBe(503);

      await waitForOutput(
        launcher,
        getOutput,
        /Stopping an unresponsive Empiri Expo process/,
        12000,
      );
      expect(Date.now() - unhealthyAt).toBeGreaterThanOrEqual(5000);
      await waitForExit(reusedMetro, 3000);

      await waitForOutput(launcher, getOutput, /FAKE_EXPO_READY_2/, 12000);
      expect(await getHttpResponse(port)).toMatchObject({
        statusCode: 200,
        body: "packager-status:running",
        projectRoot,
      });
      expect(launcher.exitCode).toBeNull();
      expect(unrelatedProcess.exitCode).toBeNull();
      expect((await getHttpResponse(unrelatedPort)).body).toBe(
        "packager-status:running",
      );

      await stopProcess(launcher);
    },
    30000,
  );
});
