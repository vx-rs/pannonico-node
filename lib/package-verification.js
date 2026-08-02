import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** PackageUnavailableError identifies only a package-resolution miss eligible for native fallback. */
export class PackageUnavailableError extends Error {
  constructor(packageName) {
    super(`Package ${packageName} is not installed`);
    this.name = "PackageUnavailableError";
    this.packageName = packageName;
  }
}

const defaultResolve = (request) => fileURLToPath(import.meta.resolve(request));

/** verifyPackage resolves and verifies one exact-version executable package before use. */
export const verifyPackage = (contract, launcherVersion, options = {}) => {
  const resolvePackage = options.resolvePackage ?? defaultResolve;
  let manifestPath;
  try {
    manifestPath = resolvePackage(`${contract.packageName}/package.json`);
  } catch {
    throw new PackageUnavailableError(contract.packageName);
  }

  const manifest = readJSONFile(manifestPath, `${contract.packageName} metadata`);
  validateManifest(manifest, contract, launcherVersion);
  const packageRoot = dirname(manifestPath);
  const payloadPath = join(packageRoot, ...contract.payload.split("/"));
  const payload = readRegularFile(payloadPath, `${contract.packageName} payload`);
  if (contract.platform !== "win32" && (lstatSync(payloadPath).mode & 0o111) === 0) {
    throw new Error(`${contract.packageName} payload is not executable`);
  }
  const checksum = readRegularFile(
    join(packageRoot, "SHA256SUMS"),
    `${contract.packageName} checksum inventory`,
  ).toString("utf8");
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\n$/.exec(checksum);
  if (!match || match[2] !== contract.payload) {
    throw new Error(`${contract.packageName} checksum inventory is malformed`);
  }
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== match[1]) {
    throw new Error(`${contract.packageName} payload checksum does not match SHA256SUMS`);
  }
  return payloadPath;
};

const readJSONFile = (filePath, label) => {
  const contents = readRegularFile(filePath, label).toString("utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
};

const readRegularFile = (filePath, label) => {
  let information;
  try {
    information = lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`${label} is not a regular non-symlink file`);
  }
  return readFileSync(filePath);
};

const validateManifest = (manifest, contract, launcherVersion) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${contract.packageName} metadata is not an object`);
  }
  if (manifest.name !== contract.packageName) {
    throw new Error(`${contract.packageName} package name is invalid`);
  }
  if (manifest.version !== launcherVersion) {
    throw new Error(
      `${contract.packageName} version ${JSON.stringify(manifest.version)} does not match launcher ${launcherVersion}`,
    );
  }
  if (
    manifest.scripts !== undefined ||
    manifest.dependencies !== undefined ||
    manifest.optionalDependencies !== undefined
  ) {
    throw new Error(`${contract.packageName} must not declare scripts or runtime dependencies`);
  }
  const identity = manifest.pannonico;
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    identity.schemaVersion !== 1 ||
    identity.edition !== "free" ||
    identity.target !== contract.target ||
    identity.payload !== contract.payload
  ) {
    throw new Error(`${contract.packageName} Pannonico edition, target, or payload is invalid`);
  }
  if (contract.platform) {
    if (
      !Array.isArray(manifest.os) ||
      manifest.os.length !== 1 ||
      manifest.os[0] !== contract.platform ||
      !Array.isArray(manifest.cpu) ||
      manifest.cpu.length !== 1 ||
      manifest.cpu[0] !== contract.architecture ||
      manifest.bin !== undefined
    ) {
      throw new Error(`${contract.packageName} OS, CPU, or bin metadata is invalid`);
    }
  } else if (
    manifest.os !== undefined ||
    manifest.cpu !== undefined ||
    manifest.bin !== undefined
  ) {
    throw new Error(`${contract.packageName} WASI metadata must not claim a native target`);
  }
};
