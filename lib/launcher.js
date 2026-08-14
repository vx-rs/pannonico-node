// Imports
// -----------------------------------------------------------------------------

// Internal
import {
  ArtifactMissingError,
  expectedNativeTarget,
  getArtifactRoot,
  readArtifactManifest,
  verifyArtifactMember,
} from "./artifacts.js";
import { createDebugLogger } from "./debug.js";
import { runNativeExecutable } from "./run-native.js";

// Public API
// -----------------------------------------------------------------------------

/**
 * main selects and runs one manifest-verified Pannonico artifact for a CLI invocation.
 *
 * The executable entrypoint supplies user arguments and receives the exact guest status. Selection
 * validates the manifest before touching a member, then verifies only the selected member's safe
 * path, checksum, and target. Automatic WASI fallback is limited to unsupported hosts and a missing
 * native member; invalid or tampered native state and native start failures remain hard errors.
 *
 * @param {string[]} argumentsToForward Product arguments from the executable entrypoint.
 * @param {object} options Runtime and focused-test overrides.
 * @returns {Promise<number>} Exact native or WASI guest exit status.
 */
export const main = async (argumentsToForward, options = {}) => {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const artifactRoot = options.artifactRoot ?? getArtifactRoot();
  const loadManifest = options.readArtifactManifest ?? readArtifactManifest;
  const verifyMember = options.verifyArtifactMember ?? verifyArtifactMember;
  const runNative = options.runNative ?? runNativeExecutable;
  const processRef = options.processRef ?? process;
  const debug = options.debug ?? createDebugLogger(environment, options.stderr ?? process.stderr);
  const manifest = await loadManifest(artifactRoot);
  const nativeTarget = expectedNativeTarget(platform, architecture);

  if (environment.PANNONICO_FORCE_WASI === "1") {
    return executeWasi(
      argumentsToForward,
      manifest,
      verifyMember,
      options,
      environment,
      artifactRoot,
    );
  }
  if (nativeTarget === undefined) {
    return executeWasi(
      argumentsToForward,
      manifest,
      verifyMember,
      options,
      environment,
      artifactRoot,
      "unsupported-native-host",
    );
  }

  let native;
  try {
    native = await verifyMember(manifest, "native", {
      artifactRoot,
      expectedTarget: nativeTarget,
    });
  } catch (error) {
    if (!(error instanceof ArtifactMissingError)) throw error;
    return executeWasi(
      argumentsToForward,
      manifest,
      verifyMember,
      options,
      environment,
      artifactRoot,
      "native-artifact-missing",
    );
  }
  debug("selected artifact native");
  debug("execution mode native");
  let result;
  try {
    result = await runNative(native.path, argumentsToForward, {
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
 *
 * @param {string[]} args Product arguments to forward.
 * @param {Record<string, unknown>} manifest Validated pair metadata.
 * @param {typeof verifyArtifactMember} verifyMember Selected-member verification boundary.
 * @param {object} options Runtime and stream overrides.
 * @param {NodeJS.ProcessEnv} environment Scoped host environment source.
 * @param {string} artifactRoot Package artifact root.
 * @param {"unsupported-native-host" | "native-artifact-missing" | undefined} fallbackReason Automatic fallback reason, if any.
 * @returns {Promise<number>} Exact WASI guest exit status.
 */
const executeWasi = async (
  args,
  manifest,
  verifyMember,
  options,
  environment,
  artifactRoot,
  fallbackReason,
) => {
  const wasi = await verifyMember(manifest, "wasi", { artifactRoot });
  if (fallbackReason !== undefined) writeFallback(options.stderr ?? process.stderr, fallbackReason);
  const runWasi = options.runWasi ?? (await import("./run-wasi.js")).runWasiExecutable;
  return runWasi(wasi.path, args, {
    cwd: options.cwd,
    environment,
    stderr: options.stderr,
    stdin: options.stdin,
    stdout: options.stdout,
  });
};

/**
 * writeFallback emits the one stable automatic-selection diagnostic on standard error.
 *
 * It is called only after the WASI member validates, so invalid or missing WASI bytes never receive
 * a fallback notice. The line records completed artifact selection, not successful execution, and
 * may precede later preparation, import, compilation, or instantiation failure. Forced WASI bypasses
 * this boundary and remains silent.
 *
 * @param {{write: (value: string) => unknown}} stderr Selected standard-error stream.
 * @param {"unsupported-native-host" | "native-artifact-missing"} reason Allowed fallback reason.
 */
const writeFallback = (stderr, reason) => {
  stderr.write(`pannonico: using WASI fallback (reason=${reason})\n`);
};
