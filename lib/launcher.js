import { readFileSync } from "node:fs";

import { createDebugLogger } from "./debug.js";
import { PackageUnavailableError, verifyPackage } from "./package-verification.js";
import { runNativeExecutable } from "./run-native.js";
import { runWasiExecutable } from "./run-wasi.js";
import { selectNativeTarget, WASI_TARGET } from "./targets.js";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** main verifies, selects, and runs the exact Pannonico package for this process. */
export const main = async (argumentsToForward, options = {}) => {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const launcherVersion = options.launcherVersion ?? PACKAGE.version;
  const verify = options.verifyPackage ?? verifyPackage;
  const runNative = options.runNative ?? runNativeExecutable;
  const runWasi = options.runWasi ?? runWasiExecutable;
  const processRef = options.processRef ?? process;
  const debug = options.debug ?? createDebugLogger(environment, options.stderr ?? process.stderr);
  const nativeTarget = selectNativeTarget(platform, architecture);

  debug(`launcher version ${launcherVersion}`);
  debug(`host ${platform}/${architecture}`);
  if (environment.PANNONICO_FORCE_WASI === "1") {
    debug("fallback reason forced by PANNONICO_FORCE_WASI=1");
    return executeWasi(argumentsToForward, launcherVersion, verify, runWasi, debug, options);
  }
  if (!nativeTarget) {
    debug("fallback reason unsupported native target");
    return executeWasi(argumentsToForward, launcherVersion, verify, runWasi, debug, options);
  }

  debug(`selected package ${nativeTarget.packageName}`);
  let executable;
  try {
    executable = verify(nativeTarget, launcherVersion);
  } catch (error) {
    if (error instanceof PackageUnavailableError) {
      debug("fallback reason optional native package unavailable");
      return executeWasi(argumentsToForward, launcherVersion, verify, runWasi, debug, options);
    }
    throw error;
  }
  debug("native metadata and checksum verified");
  debug("execution mode native");
  let result;
  try {
    result = await runNative(executable, argumentsToForward, {
      cwd: options.cwd,
      environment,
    });
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (["EACCES", "EPERM", "ENOENT", "ENOEXEC"].includes(code)) {
      throw new Error(
        `The verified native executable could not start (${code}). Retry with PANNONICO_FORCE_WASI=1 to use the portable fallback.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (result.signal) {
    processRef.kill(processRef.pid, result.signal);
    return 1;
  }
  return result.status;
};

const executeWasi = async (args, version, verify, runWasi, debug, options) => {
  debug(`selected package ${WASI_TARGET.packageName}`);
  let modulePath;
  try {
    modulePath = verify(WASI_TARGET, version);
  } catch (error) {
    if (error instanceof PackageUnavailableError) {
      throw new Error(
        `${WASI_TARGET.packageName} is required but unavailable. Reinstall @vx.rs/pannonico without omitting regular dependencies.`,
        { cause: error },
      );
    }
    throw error;
  }
  debug("WASI metadata and checksum verified");
  debug("execution mode WASI");
  return runWasi(modulePath, args, {
    cwd: options.cwd,
    environment: options.environment,
    stderr: options.stderr,
    stdin: options.stdin,
    stdout: options.stdout,
  });
};
