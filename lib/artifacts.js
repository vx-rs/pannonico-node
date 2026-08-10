import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Constants
// -----------------------------------------------------------------------------

const ARTIFACT_ROOT = fileURLToPath(new URL("../artifacts/", import.meta.url));

// Public API
// -----------------------------------------------------------------------------

/**
 * getArtifactPaths returns the two fixed files owned by the local launcher.
 *
 * The launcher calls this once during selection and never searches the PATH or platform package
 * directories. The platform affects only the Windows executable suffix; the WASI path is stable.
 */
export const getArtifactPaths = (platform = process.platform) => ({
  native: join(ARTIFACT_ROOT, "native", platform === "win32" ? "pannonico.exe" : "pannonico"),
  wasi: join(ARTIFACT_ROOT, "pannonico.wasm"),
});

/**
 * inspectArtifact validates one manually copied launcher artifact without following symlinks.
 *
 * Selection treats an absent file as unavailable and may choose WASI, but inspection failures,
 * special files, symlinks, and missing POSIX execute bits fail closed. The function validates
 * local file shape only; the developer remains responsible for the artifact's origin and edition.
 */
export const inspectArtifact = (filePath, label, options = {}) => {
  let information;
  try {
    information = lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw new Error(`${label} could not be inspected`, { cause: error });
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (options.executable && options.platform !== "win32" && (information.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable`);
  }
  return true;
};
