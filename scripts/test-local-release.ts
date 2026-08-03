import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPackage } from "../lib/package-verification.js";
import { NATIVE_TARGETS, selectNativeTarget, WASI_TARGET } from "../lib/targets.js";
import { expectedTarballs } from "./package-local-release.ts";
import { validateVersion } from "./release-package.ts";

const CURRENT_FILE = fileURLToPath(import.meta.url);

/** testLocalRelease installs local tarballs offline and exercises native and forced-WASI consumers. */
export const testLocalRelease = (input, options = {}) => {
  const version = validateVersion(input.version);
  const packages = resolve(input.packages);
  for (const name of expectedTarballs(version)) {
    if (!existsSync(join(packages, name))) throw new Error(`Missing local package ${name}`);
  }
  const native = selectNativeTarget(process.platform, process.arch);
  if (!native)
    throw new Error(`No local native consumer target for ${process.platform}/${process.arch}`);
  const workspace = mkdtempSync(join(os.tmpdir(), "pannonico-consumer-"));
  try {
    for (const contract of [...NATIVE_TARGETS, WASI_TARGET]) {
      verifyTargetTarball(contract, version, packages, workspace, options.runCommand);
    }
    runConsumer("native", native, version, packages, workspace, options.runCommand);
    runConsumer("missing-native", WASI_TARGET, version, packages, workspace, options.runCommand);
    runConsumer("wasi", WASI_TARGET, version, packages, workspace, options.runCommand);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

const verifyTargetTarball = (contract, version, packages, workspace, runCommand = spawnSync) => {
  const consumer = join(workspace, `verify-${contract.target}`);
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
  const environment = {
    ...process.env,
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_offline: "true",
  };
  run(
    "npm",
    [
      "install",
      "--force",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(packages, `${contract.packageName.slice("@vx.rs/".length)}-${version}.tgz`),
    ],
    consumer,
    environment,
    runCommand,
  );
  const manifest = join(
    consumer,
    "node_modules",
    ...contract.packageName.split("/"),
    "package.json",
  );
  verifyPackage(contract, version, { resolvePackage: () => manifest });
};

const runConsumer = (mode, artifact, version, packages, workspace, runCommand = spawnSync) => {
  const consumer = join(workspace, mode);
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true}\n');
  const environment = {
    ...process.env,
    npm_config_cache: join(workspace, "npm-cache"),
    npm_config_offline: "true",
    ...(mode === "wasi" ? { PANNONICO_FORCE_WASI: "1" } : {}),
  };
  const packageFiles = [
    join(packages, `pannonico-${version}.tgz`),
    join(packages, `${artifact.packageName.slice("@vx.rs/".length)}-${version}.tgz`),
    join(packages, `${WASI_TARGET.packageName.slice("@vx.rs/".length)}-${version}.tgz`),
  ];
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      ...new Set(packageFiles),
    ],
    consumer,
    environment,
    runCommand,
  );
  const wrapper = join(consumer, "node_modules", "@vx.rs", "pannonico", "bin", "pannonico.js");
  const versionResult = run(
    process.execPath,
    [wrapper, "--version"],
    consumer,
    environment,
    runCommand,
  );
  if (!`${versionResult.stdout}${versionResult.stderr}`.includes(version)) {
    throw new Error(`${mode} consumer returned an unexpected version`);
  }
  if (mode === "native" && versionResult.stderr.includes("ExperimentalWarning: WASI")) {
    throw new Error("native consumer initialized the experimental WASI host");
  }
  run(process.execPath, [wrapper, "--help"], consumer, environment, runCommand);
  run(process.execPath, [wrapper, "scaffold", "site"], consumer, environment, runCommand);
  run(process.execPath, [wrapper, "build", "site"], consumer, environment, runCommand);
  if (!existsSync(join(consumer, "site", "dist", "index.html"))) {
    throw new Error(`${mode} consumer did not build site/dist/index.html`);
  }
};

const run = (command, args, cwd, environment, runCommand) => {
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
  if (arguments_.length !== 4) {
    throw new Error("Usage: test-local-release --version VERSION --packages DIR");
  }
  const values = Object.fromEntries([
    [arguments_[0]?.slice(2), arguments_[1]],
    [arguments_[2]?.slice(2), arguments_[3]],
  ]);
  if (!values.version || !values.packages) {
    throw new Error("Usage: test-local-release --version VERSION --packages DIR");
  }
  return values;
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    testLocalRelease(parseArguments(process.argv.slice(2)));
    console.log("Native, missing-native, and forced-WASI local consumers passed");
  } catch (error) {
    console.error(`Local consumer test failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
