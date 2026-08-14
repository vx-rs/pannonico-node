// Imports
// -----------------------------------------------------------------------------

// Node.js
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

// Internal
import { ArtifactMissingError } from "../lib/artifacts.js";
import { createDebugLogger } from "../lib/debug.js";
import { main } from "../lib/launcher.js";
import { runNativeExecutable } from "../lib/run-native.js";

// Fixtures
// -----------------------------------------------------------------------------

const ARTIFACTS = {
  native: "/launcher/artifacts/native/pannonico",
  wasi: "/launcher/artifacts/pannonico.wasm",
};
const MANIFEST = { artifacts: [{ kind: "native" }, { kind: "wasi" }] };

/**
 * createSelectionOptions supplies manifest and selected-member boundaries without filesystem I/O.
 *
 * Launcher tests override only behavior needed by each selection case. The default models a valid
 * Linux pair and lets tests assert which exact verified path reaches each process runner.
 *
 * @returns {object} Default focused launcher options.
 */
const createSelectionOptions = () => ({
  environment: {},
  platform: "linux",
  architecture: "x64",
  artifactRoot: "/launcher/artifacts",
  readArtifactManifest: async () => MANIFEST,
  verifyArtifactMember: async (_manifest, kind, options) => {
    assert.equal(options.artifactRoot, "/launcher/artifacts");
    if (kind === "native") {
      assert.equal(options.expectedTarget, "linux-amd64");
      return { path: ARTIFACTS.native, record: MANIFEST.artifacts[0] };
    }
    return { path: ARTIFACTS.wasi, record: MANIFEST.artifacts[1] };
  },
  debug: () => {},
});

// Launcher selection
// -----------------------------------------------------------------------------

test("importing the launcher does not initialize the experimental WASI host", () => {
  const launcher = new URL("../lib/launcher.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(launcher)})`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning: WASI/);
});

test("forwards native arguments, process boundary, and exact exit status", async () => {
  let invocation;
  const environment = { TEST_VALUE: "yes" };
  const status = await main(["build", "site"], {
    ...createSelectionOptions(),
    environment,
    runNative: async (executable, args, options) => {
      invocation = { executable, args, options };
      return { signal: null, status: 17 };
    },
    debug: () => {},
  });
  assert.equal(status, 17);
  assert.deepEqual(invocation, {
    executable: ARTIFACTS.native,
    args: ["build", "site"],
    options: { cwd: undefined, environment },
  });
});

test("emits exact fallback stderr only for unsupported host after verified WASI", async () => {
  let output = "";
  let wasiUsed = false;
  const status = await main(["--version"], {
    ...createSelectionOptions(),
    platform: "aix",
    architecture: "ppc64",
    stderr: { write: (value) => (output += value) },
    runWasi: async (module, args) => {
      wasiUsed = module === ARTIFACTS.wasi && args[0] === "--version";
      return 9;
    },
  });
  assert.equal(status, 9);
  assert.equal(wasiUsed, true);
  assert.equal(output, "pannonico: using WASI fallback (reason=unsupported-native-host)\n");
});

test("emits exact fallback stderr only for a missing native member", async () => {
  let output = "";
  const options = createSelectionOptions();
  const verify = options.verifyArtifactMember;
  const status = await main([], {
    ...options,
    stderr: { write: (value) => (output += value) },
    verifyArtifactMember: async (manifest, kind, selection) => {
      if (kind === "native") {
        throw new ArtifactMissingError(
          "native artifact",
          Object.assign(new Error(), { code: "ENOENT" }),
        );
      }
      return verify(manifest, kind, selection);
    },
    runWasi: async () => 7,
  });
  assert.equal(status, 7);
  assert.equal(output, "pannonico: using WASI fallback (reason=native-artifact-missing)\n");
});

test("forced WASI verifies only WASI and remains silent", async () => {
  let output = "";
  const selected = [];
  const status = await main([], {
    ...createSelectionOptions(),
    environment: { PANNONICO_FORCE_WASI: "1" },
    stderr: { write: (value) => (output += value) },
    verifyArtifactMember: async (_manifest, kind) => {
      selected.push(kind);
      return { path: ARTIFACTS.wasi, record: MANIFEST.artifacts[1] };
    },
    runWasi: async () => 8,
  });
  assert.equal(status, 8);
  assert.deepEqual(selected, ["wasi"]);
  assert.equal(output, "");
});

test("never falls back after native metadata, safety, or checksum validation fails", async () => {
  let wasiUsed = false;
  await assert.rejects(
    main([], {
      ...createSelectionOptions(),
      verifyArtifactMember: async () => {
        throw new Error("native artifact checksum mismatch");
      },
      runWasi: async () => {
        wasiUsed = true;
        return 0;
      },
      debug: () => {},
    }),
    /checksum mismatch/,
  );
  assert.equal(wasiUsed, false);
});

test("treats a missing selected WASI member as a hard failure", async () => {
  await assert.rejects(
    main([], {
      ...createSelectionOptions(),
      environment: { PANNONICO_FORCE_WASI: "1" },
      verifyArtifactMember: async () => {
        throw new ArtifactMissingError(
          "WASI artifact",
          Object.assign(new Error(), { code: "ENOENT" }),
        );
      },
    }),
    /WASI artifact is missing/,
  );
});

test("rejects an invalid manifest before selecting any member", async () => {
  let selected = false;
  await assert.rejects(
    main([], {
      ...createSelectionOptions(),
      readArtifactManifest: async () => {
        throw new Error("artifact manifest pairId mismatch");
      },
      verifyArtifactMember: async () => {
        selected = true;
      },
    }),
    /pairId mismatch/,
  );
  assert.equal(selected, false);
});

test("reports blocked native execution with explicit forced-WASI guidance", async () => {
  await assert.rejects(
    main([], {
      ...createSelectionOptions(),
      runNative: async () => {
        const error = new Error("blocked");
        error.code = "EACCES";
        throw error;
      },
      debug: () => {},
    }),
    /PANNONICO_FORCE_WASI=1/,
  );
});

test("propagates a native termination signal through the parent process", async () => {
  let received;
  const status = await main([], {
    ...createSelectionOptions(),
    runNative: async () => ({ signal: "SIGTERM", status: 1 }),
    processRef: {
      pid: 42,
      kill: (pid, signal) => {
        received = { pid, signal };
      },
    },
    debug: () => {},
  });
  assert.equal(status, 1);
  assert.deepEqual(received, { pid: 42, signal: "SIGTERM" });
});

// Process and diagnostics
// -----------------------------------------------------------------------------

test("native process runner inherits streams and caller context", async () => {
  let received;
  const child = new EventEmitter();
  const pending = runNativeExecutable("/local/pannonico", ["--help"], {
    cwd: "/project",
    environment: { A: "B" },
    spawnProcess: (file, args, options) => {
      received = { file, args, options };
      return child;
    },
  });
  child.emit("exit", 23, null);
  assert.deepEqual(await pending, { signal: null, status: 23 });
  assert.deepEqual(received, {
    file: "/local/pannonico",
    args: ["--help"],
    options: {
      cwd: "/project",
      detached: process.platform !== "win32",
      env: { A: "B" },
      stdio: "inherit",
    },
  });
});

test("native process runner forwards termination signals and removes its listeners", async () => {
  let receivedSignal;
  const child = new EventEmitter();
  child.kill = (signal) => {
    receivedSignal = signal;
  };
  const signalSource = new EventEmitter();
  const pending = runNativeExecutable("/local/pannonico", [], {
    signalSource,
    spawnProcess: () => child,
  });
  signalSource.emit("SIGINT");
  assert.equal(receivedSignal, "SIGINT");
  child.emit("exit", 0, null);
  assert.deepEqual(await pending, { signal: null, status: 0 });
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
});

test("native process runner removes signal listeners after a spawn error", async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const signalSource = new EventEmitter();
  const pending = runNativeExecutable("/local/pannonico", [], {
    signalSource,
    spawnProcess: () => child,
  });
  const error = Object.assign(new Error("could not spawn"), { code: "ENOENT" });
  child.emit("error", error);
  await assert.rejects(pending, error);
  assert.equal(signalSource.listenerCount("SIGHUP"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("native process runner queues startup signals until the child exists", async () => {
  let receivedSignal;
  const child = new EventEmitter();
  child.kill = (signal) => {
    receivedSignal = signal;
  };
  const signalSource = new EventEmitter();
  const pending = runNativeExecutable("/local/pannonico", [], {
    signalSource,
    spawnProcess: () => {
      signalSource.emit("SIGINT");
      return child;
    },
  });
  assert.equal(receivedSignal, "SIGINT");
  child.emit("exit", 0, null);
  assert.deepEqual(await pending, { signal: null, status: 0 });
});

test("native process runner removes signal listeners after synchronous spawn failure", async () => {
  const signalSource = new EventEmitter();
  const error = Object.assign(new Error("spawn threw"), { code: "ENOENT" });
  const pending = runNativeExecutable("/local/pannonico", [], {
    signalSource,
    spawnProcess: () => {
      throw error;
    },
  });
  await assert.rejects(pending, error);
  assert.equal(signalSource.listenerCount("SIGHUP"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test(
  "native process runner delivers a terminal signal once on POSIX",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-signal-"));
    const countPath = join(root, "signal-count");
    const readyPath = join(root, "ready");
    const runner = new URL("../lib/run-native.js", import.meta.url).href;
    const childProgram = `
      const { writeFileSync } = await import("node:fs");
      let count = 0;
      process.on("SIGINT", () => {
        count += 1;
        setTimeout(() => {
          writeFileSync(${JSON.stringify(countPath)}, String(count));
          process.exit(0);
        }, 100);
      });
      writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const launcherProgram = `
      const { runNativeExecutable } = await import(${JSON.stringify(runner)});
      const result = await runNativeExecutable(process.execPath, [
        "--input-type=module",
        "--eval",
        ${JSON.stringify(childProgram)},
      ]);
      process.exitCode = result.status;
    `;
    const launcher = spawn(process.execPath, ["--input-type=module", "--eval", launcherProgram], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", (value) => {
      stderr += value;
    });
    let nativePID;
    let cleanupError;
    let exitTimeout;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          nativePID = Number(readFileSync(readyPath, "utf8"));
          break;
        } catch (error) {
          if (!error || error.code !== "ENOENT") throw error;
          if (launcher.exitCode !== null || launcher.signalCode !== null) {
            throw new Error(
              `signal fixture exited before readiness with code ${launcher.exitCode} and signal ${launcher.signalCode ?? "none"}: ${stderr}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(
        Number.isInteger(nativePID) && nativePID > 0,
        `signal fixture did not become ready: ${stderr}`,
      );
      const launcherExit = once(launcher, "exit");
      process.kill(-launcher.pid, "SIGINT");
      const [status, signal] = await Promise.race([
        launcherExit,
        new Promise((_, reject) => {
          exitTimeout = setTimeout(
            () => reject(new Error(`signal fixture did not exit after SIGINT: ${stderr}`)),
            2_000,
          );
        }),
      ]);
      clearTimeout(exitTimeout);
      exitTimeout = undefined;
      assert.equal(signal, null, stderr);
      assert.equal(status, 0, stderr);
      assert.equal(readFileSync(countPath, "utf8"), "1");
    } finally {
      clearTimeout(exitTimeout);
      if (launcher.exitCode === null && launcher.signalCode === null) {
        try {
          process.kill(-launcher.pid, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") cleanupError ??= error;
        }
      }
      if (nativePID) {
        try {
          process.kill(nativePID, "SIGKILL");
        } catch (error) {
          if (!error || error.code !== "ESRCH") cleanupError ??= error;
        }
      }
      rmSync(root, { force: true, recursive: true });
    }
    if (cleanupError) throw cleanupError;
  },
);

test("debug output is silent by default and contains only selected safe fields when enabled", () => {
  let output = "";
  const stderr = {
    write: (value) => {
      output += value;
    },
  };
  createDebugLogger({}, stderr)("selected artifact native");
  assert.equal(output, "");
  createDebugLogger({ PANNONICO_LAUNCHER_DEBUG: "1" }, stderr)("execution mode WASI");
  assert.equal(output, "[pannonico launcher] execution mode WASI\n");
});
