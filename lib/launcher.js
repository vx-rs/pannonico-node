import { getArtifactPaths, inspectArtifact } from "./artifacts.js";
import { createDebugLogger } from "./debug.js";
import { runNativeExecutable } from "./run-native.js";

// Constants
// -----------------------------------------------------------------------------

const SUPPORTED_NATIVE_HOSTS = new Set([
  "darwin/arm64",
  "darwin/x64",
  "linux/arm64",
  "linux/x64",
  "win32/arm64",
  "win32/x64",
]);

// Public API
// -----------------------------------------------------------------------------

/**
 * main selects and runs the manually installed Pannonico artifact for one CLI invocation.
 *
 * The executable entrypoint supplies user arguments and receives the exact guest status. Native
 * selection is allowed only for known host pairs and a validated fixed file; forced, unavailable,
 * or unsupported native execution uses the validated WASI file. Unsafe files and native start
 * failures do not silently fall back because doing so could execute a different edition.
 */
export const main = async (argumentsToForward, options = {}) => {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const artifactPaths = options.artifactPaths ?? getArtifactPaths(platform);
  const inspect = options.inspectArtifact ?? inspectArtifact;
  const runNative = options.runNative ?? runNativeExecutable;
  const processRef = options.processRef ?? process;
  const debug = options.debug ?? createDebugLogger(environment, options.stderr ?? process.stderr);

  debug(`host ${platform}/${architecture}`);
  if (environment.PANNONICO_FORCE_WASI === "1") {
    debug("fallback reason forced by PANNONICO_FORCE_WASI=1");
    return executeWasi(
      argumentsToForward,
      artifactPaths,
      inspect,
      debug,
      options,
      environment,
      platform,
    );
  }
  if (!SUPPORTED_NATIVE_HOSTS.has(`${platform}/${architecture}`)) {
    debug("fallback reason unsupported native target");
    return executeWasi(
      argumentsToForward,
      artifactPaths,
      inspect,
      debug,
      options,
      environment,
      platform,
    );
  }

  if (!inspect(artifactPaths.native, "local native artifact", { executable: true, platform })) {
    debug("fallback reason local native artifact unavailable");
    return executeWasi(
      argumentsToForward,
      artifactPaths,
      inspect,
      debug,
      options,
      environment,
      platform,
    );
  }
  debug("selected artifact native");
  debug("execution mode native");
  let result;
  try {
    result = await runNative(artifactPaths.native, argumentsToForward, {
      cwd: options.cwd,
      environment,
    });
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (["EACCES", "EPERM", "ENOENT", "ENOEXEC"].includes(code)) {
      throw new Error(
        `The local native artifact could not start (${code}). Retry with PANNONICO_FORCE_WASI=1 to use the portable fallback.`,
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

// WASI execution
// -----------------------------------------------------------------------------

/**
 * executeWasi validates and starts the fixed portable artifact on behalf of main.
 *
 * The dynamic import keeps Node's experimental WASI host uninitialized during native execution.
 * A missing or unsafe artifact rejects the invocation; otherwise the confined host owns project
 * preopens, approved environment forwarding, inherited streams, and the returned guest status.
 */
const executeWasi = async (args, artifactPaths, inspect, debug, options, environment, platform) => {
  if (!inspect(artifactPaths.wasi, "local WASI artifact", { platform })) {
    throw new Error(
      "The local WASI artifact is missing. Copy pannonico.wasm into the launcher artifacts directory.",
    );
  }
  debug("selected artifact WASI");
  debug("execution mode WASI");
  const runWasi = options.runWasi ?? (await import("./run-wasi.js")).runWasiExecutable;
  return runWasi(artifactPaths.wasi, args, {
    cwd: options.cwd,
    environment,
    stderr: options.stderr,
    stdin: options.stdin,
    stdout: options.stdout,
  });
};
