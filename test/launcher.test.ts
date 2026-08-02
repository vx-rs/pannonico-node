import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDebugLogger } from "../lib/debug.js";
import { main } from "../lib/launcher.js";
import { PackageUnavailableError } from "../lib/package-verification.js";
import { runNativeExecutable } from "../lib/run-native.js";

test("forwards native arguments, process boundary, and exact exit status", async () => {
  let invocation;
  const environment = { TEST_VALUE: "yes" };
  const status = await main(["build", "site"], {
    environment,
    launcherVersion: "1.2.3",
    platform: "linux",
    architecture: "x64",
    verifyPackage: () => "/verified/pannonico",
    runNative: async (executable, args, options) => {
      invocation = { executable, args, options };
      return { signal: null, status: 17 };
    },
    debug: () => {},
  });
  assert.equal(status, 17);
  assert.deepEqual(invocation, {
    executable: "/verified/pannonico",
    args: ["build", "site"],
    options: { cwd: undefined, environment },
  });
});

test("falls back only for forced, unsupported, or unavailable native selection", async () => {
  for (const options of [
    { environment: { PANNONICO_FORCE_WASI: "1" }, platform: "linux", architecture: "x64" },
    { environment: {}, platform: "aix", architecture: "ppc64" },
    { environment: {}, platform: "linux", architecture: "x64", unavailable: true },
  ]) {
    let wasiUsed = false;
    const status = await main(["--version"], {
      ...options,
      launcherVersion: "1.2.3",
      verifyPackage: (contract) => {
        if (options.unavailable && contract.target !== "wasi") {
          throw new PackageUnavailableError(contract.packageName);
        }
        return contract.target === "wasi" ? "/verified/pannonico.wasm" : "/verified/pannonico";
      },
      runNative: async () => ({ signal: null, status: 0 }),
      runWasi: async (module, args) => {
        wasiUsed = module.endsWith(".wasm") && args[0] === "--version";
        return 9;
      },
      debug: () => {},
    });
    assert.equal(status, 9);
    assert.equal(wasiUsed, true);
  }
});

test("never falls back after installed native verification fails", async () => {
  let wasiUsed = false;
  await assert.rejects(
    main([], {
      environment: {},
      platform: "linux",
      architecture: "x64",
      launcherVersion: "1.2.3",
      verifyPackage: () => {
        throw new Error("checksum mismatch");
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

test("reports blocked native execution with explicit forced-WASI guidance", async () => {
  await assert.rejects(
    main([], {
      environment: {},
      platform: "linux",
      architecture: "x64",
      launcherVersion: "1.2.3",
      verifyPackage: () => "/verified/pannonico",
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
    environment: {},
    platform: "linux",
    architecture: "x64",
    launcherVersion: "1.2.3",
    verifyPackage: () => "/verified/pannonico",
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

test("native process runner inherits streams and caller context", async () => {
  let received;
  const child = new EventEmitter();
  const pending = runNativeExecutable("/verified/pannonico", ["--help"], {
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
    file: "/verified/pannonico",
    args: ["--help"],
    options: { cwd: "/project", env: { A: "B" }, stdio: "inherit" },
  });
});

test("debug output is silent by default and contains only selected safe fields when enabled", () => {
  let output = "";
  const stderr = {
    write: (value) => {
      output += value;
    },
  };
  createDebugLogger({}, stderr)("selected package @vx.rs/pannonico-wasi");
  assert.equal(output, "");
  createDebugLogger({ PANNONICO_LAUNCHER_DEBUG: "1" }, stderr)("execution mode WASI");
  assert.equal(output, "[pannonico launcher] execution mode WASI\n");
});
