import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateVersion } from "./release-package.ts";

const CURRENT_FILE = fileURLToPath(import.meta.url);

/** testRegistryConsumers installs one local or registry wrapper against immutable dependencies. */
export const testRegistryConsumers = (version, wrapper, runCommand = spawnSync) => {
  validateVersion(version);
  const packageInput = wrapper.startsWith("@") ? wrapper : resolve(wrapper);
  if (!wrapper.startsWith("@") && !existsSync(packageInput)) {
    throw new Error(`Wrapper tarball is missing: ${packageInput}`);
  }
  const workspace = mkdtempSync(join(os.tmpdir(), "pannonico-registry-consumer-"));
  try {
    for (const mode of ["native", "missing-native", "wasi"]) {
      const consumer = join(workspace, mode);
      mkdirSync(consumer);
      writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
      const environment = {
        ...process.env,
        npm_config_cache: join(workspace, "npm-cache"),
        ...(mode === "wasi" ? { PANNONICO_FORCE_WASI: "1" } : {}),
      };
      const installArguments = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
      if (mode === "missing-native") installArguments.push("--omit=optional");
      installArguments.push(packageInput);
      run(runCommand, "npm", installArguments, consumer, environment);
      const wrapper = join(consumer, "node_modules", "@vx.rs", "pannonico", "bin", "pannonico.js");
      const result = run(
        runCommand,
        process.execPath,
        [wrapper, "--version"],
        consumer,
        environment,
      );
      if (!`${result.stdout}${result.stderr}`.includes(version)) {
        throw new Error(`${mode} registry consumer returned an unexpected version`);
      }
      run(runCommand, process.execPath, [wrapper, "--help"], consumer, environment);
    }
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

const run = (runCommand, command, args, cwd, environment) => {
  const result = runCommand(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stdout}${result.stderr}`);
  }
  return result;
};

const parseArguments = (arguments_) => {
  const versionIndex = arguments_.indexOf("--version");
  const wrapperIndex = arguments_.indexOf("--wrapper");
  const packageIndex = arguments_.indexOf("--package");
  const version = arguments_[versionIndex + 1];
  const wrapper = wrapperIndex >= 0 ? arguments_[wrapperIndex + 1] : arguments_[packageIndex + 1];
  if (versionIndex < 0 || wrapperIndex < 0 === packageIndex < 0 || !version || !wrapper) {
    throw new Error(
      "Usage: test-registry-consumer --version VERSION (--wrapper FILE | --package SPEC)",
    );
  }
  return { version, wrapper };
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    const input = parseArguments(process.argv.slice(2));
    testRegistryConsumers(input.version, input.wrapper);
    console.log("Registry-backed native, missing-native, and forced-WASI consumers passed");
  } catch (error) {
    console.error(
      `Registry consumer test failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
