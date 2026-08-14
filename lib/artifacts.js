// Imports
// -----------------------------------------------------------------------------

// Node.js
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Constants
// -----------------------------------------------------------------------------

const ARTIFACT_ROOT = fileURLToPath(new URL("../artifacts/", import.meta.url));
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TARGET_NAME = /^[a-z0-9]+-[a-z0-9]+$/;
const SOURCE_REVISION = /^(?:development|[0-9a-f]{40})$/;
const PRODUCT_VERSION = /^[!-~]+$/;
const NATIVE_TARGETS = new Set([
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64",
]);
const HOST_TARGETS = new Map([
  ["darwin/x64", "darwin-amd64"],
  ["darwin/arm64", "darwin-arm64"],
  ["linux/x64", "linux-amd64"],
  ["linux/arm64", "linux-arm64"],
  ["win32/x64", "windows-amd64"],
  ["win32/arm64", "windows-arm64"],
]);

// Errors
// -----------------------------------------------------------------------------

/**
 * ArtifactMissingError identifies an absent selected member without weakening other validation.
 *
 * The launcher catches only this error for the documented native-missing fallback. Unsafe paths,
 * malformed metadata, checksum failures, and all WASI selection failures remain hard errors.
 */
export class ArtifactMissingError extends Error {
  /**
   * constructor preserves the selected member label and filesystem cause for diagnostics.
   *
   * Callers use the class identity, rather than message parsing, to decide whether native fallback
   * is permitted. The error does not expose a broader recovery category.
   *
   * @param {string} label Human-readable selected member label.
   * @param {unknown} cause Original missing-path error.
   */
  constructor(label, cause) {
    super(`${label} is missing`, { cause });
    this.name = "ArtifactMissingError";
  }
}

// Canonical metadata
// -----------------------------------------------------------------------------

/**
 * canonicalJSONString serializes manifest identity input with recursively sorted object keys.
 *
 * Producer and consumer use this v1 rule to bind paths, digests, identities, and fixed array order
 * into one pair ID. Undefined and non-JSON values are rejected by manifest validation before this
 * boundary, so the result is deterministic UTF-8 JSON without insignificant whitespace.
 *
 * @param {unknown} value JSON-compatible value to serialize.
 * @returns {string} Canonical JSON text.
 */
export const canonicalJSONString = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSONString(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSONString(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * calculatePairId computes the schema-v1 identity while omitting only the pairId field itself.
 *
 * Manifest loading calls this after structural validation. Keeping the omission at this boundary
 * prevents callers from accidentally excluding paths, checksums, or other pair-bound metadata.
 *
 * @param {Record<string, unknown>} manifest Validated manifest object.
 * @returns {string} Lowercase SHA-256 digest of canonical UTF-8 JSON.
 */
export const calculatePairId = (manifest) => {
  const { pairId: _pairId, ...identity } = manifest;
  return createHash("sha256").update(canonicalJSONString(identity), "utf8").digest("hex");
};

// Schema validation
// -----------------------------------------------------------------------------

/**
 * assertExactKeys rejects missing and additional fields at each fixed schema-v1 object boundary.
 *
 * The manifest is a closed package contract, not an extensible configuration file. Exact key sets
 * make unknown producer output fail closed until a future schema version defines its semantics.
 *
 * @param {unknown} value Candidate object.
 * @param {string[]} expected Expected property names.
 * @param {string} label Error context.
 */
const assertExactKeys = (value, expected, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
};

/**
 * validateArtifactPath enforces portable relative paths before any filesystem access occurs.
 *
 * Forward-slash segments are part of the package schema on every host. Rejecting empty, dot, and
 * parent segments prevents platform normalization from turning metadata into an escape path.
 *
 * @param {unknown} value Candidate manifest path.
 * @param {string} label Error context.
 * @returns {string[]} Safe path segments.
 */
const validateArtifactPath = (value, label) => {
  if (typeof value !== "string" || value === "" || value.includes("\\")) {
    throw new Error(`${label} must be a nonempty forward-slash relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${label} must be relative`);
  }
  return segments;
};

/**
 * validateCapabilities validates ordered discovery records without recreating product policy.
 *
 * Node accepts any strictly name-ordered, duplicate-free capability projection with positive v1
 * record versions. It does not compare native and WASI arrays because target sets may differ.
 *
 * @param {unknown} value Candidate capability array.
 * @param {string} label Error context.
 */
const validateCapabilities = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  let previous = "";
  for (const [index, record] of value.entries()) {
    const recordLabel = `${label}[${index}]`;
    assertExactKeys(record, ["name", "version"], recordLabel);
    if (typeof record.name !== "string" || !CAPABILITY_NAME.test(record.name)) {
      throw new Error(`${recordLabel}.name is invalid`);
    }
    if (previous !== "" && record.name <= previous) {
      throw new Error(`${label} must be strictly ordered by capability name`);
    }
    if (!Number.isInteger(record.version) || record.version < 1) {
      throw new Error(`${recordLabel}.version must be a positive integer`);
    }
    previous = record.name;
  }
};

/**
 * validateArtifactRecord validates one fixed-position native or WASI metadata record.
 *
 * The function checks only schema-owned target and filename rules plus capability record shape.
 * Selected bytes and host compatibility are verified later so an unselected missing member does
 * not block runtime execution.
 *
 * @param {unknown} value Candidate artifact record.
 * @param {"native" | "wasi"} expectedKind Kind required at this array position.
 */
const validateArtifactRecord = (value, expectedKind) => {
  const label = `${expectedKind} artifact`;
  assertExactKeys(value, ["kind", "path", "target", "sha256", "capabilities"], label);
  if (value.kind !== expectedKind) throw new Error(`${label}.kind must be ${expectedKind}`);
  validateArtifactPath(value.path, `${label}.path`);
  if (typeof value.target !== "string" || !TARGET_NAME.test(value.target)) {
    throw new Error(`${label}.target is invalid`);
  }
  if (expectedKind === "wasi") {
    if (value.path !== "pannonico.wasm")
      throw new Error("WASI artifact path must be pannonico.wasm");
    if (value.target !== "wasip1-wasm") throw new Error("WASI artifact target must be wasip1-wasm");
  } else {
    if (!NATIVE_TARGETS.has(value.target)) {
      throw new Error(`native artifact target ${JSON.stringify(value.target)} is unsupported`);
    }
    const suffix = value.target.startsWith("windows-")
      ? "native/pannonico.exe"
      : "native/pannonico";
    if (value.path !== suffix && !value.path.endsWith(`/${suffix}`)) {
      throw new Error(`native artifact path must end in ${suffix}`);
    }
  }
  if (typeof value.sha256 !== "string" || !HEX_DIGEST.test(value.sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  validateCapabilities(value.capabilities, `${label}.capabilities`);
};

/**
 * validateManifest checks the complete closed v1 metadata schema and canonical pair identity.
 *
 * Runtime loading uses this before selecting any member. The checks deliberately do not infer the
 * Go edition, version, or source revision from binaries because those are producer guarantees.
 *
 * @param {unknown} value Parsed manifest candidate.
 * @returns {Record<string, unknown>} Validated manifest object.
 */
export const validateManifest = (value) => {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "productVersion",
      "sourceRevision",
      "edition",
      "pairId",
      "artifacts",
    ],
    "artifact manifest",
  );
  if (value.schemaVersion !== 1) throw new Error("artifact manifest schemaVersion must be 1");
  if (value.product !== "pannonico") throw new Error("artifact manifest product must be pannonico");
  if (typeof value.productVersion !== "string" || !PRODUCT_VERSION.test(value.productVersion)) {
    throw new Error("artifact manifest productVersion is invalid");
  }
  if (typeof value.sourceRevision !== "string" || !SOURCE_REVISION.test(value.sourceRevision)) {
    throw new Error("artifact manifest sourceRevision is invalid");
  }
  if (!new Set(["free", "pro"]).has(value.edition)) {
    throw new Error("artifact manifest edition must be free or pro");
  }
  if (typeof value.pairId !== "string" || !HEX_DIGEST.test(value.pairId)) {
    throw new Error("artifact manifest pairId must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== 2) {
    throw new Error("artifact manifest artifacts must contain native then WASI");
  }
  validateArtifactRecord(value.artifacts[0], "native");
  validateArtifactRecord(value.artifacts[1], "wasi");
  if (calculatePairId(value) !== value.pairId) throw new Error("artifact manifest pairId mismatch");
  return value;
};

// Public API
// -----------------------------------------------------------------------------

/**
 * getArtifactRoot returns the package-owned directory that contains the manifest and pair members.
 *
 * Launcher selection uses this fixed module-relative root and never searches PATH or platform
 * package locations. Tests may supply another root explicitly without changing package behavior.
 *
 * @returns {string} Absolute artifact-root path.
 */
export const getArtifactRoot = () => ARTIFACT_ROOT;

/**
 * expectedNativeTarget maps exactly the six supported Node host pairs to Go target identifiers.
 *
 * Launcher selection uses an undefined result as the unsupported-host fallback reason. Keeping the
 * table beside manifest target validation prevents architecture aliases from broadening execution.
 *
 * @param {string} platform Node platform identifier.
 * @param {string} architecture Node architecture identifier.
 * @returns {string | undefined} Required native target, if supported.
 */
export const expectedNativeTarget = (platform = process.platform, architecture = process.arch) =>
  HOST_TARGETS.get(`${platform}/${architecture}`);

/**
 * getArtifactPaths returns fixed default member locations for compatibility and diagnostics.
 *
 * Runtime execution uses manifest paths after validation. This projection remains useful to tests
 * and local tooling that need the conventional package paths without selecting or opening files.
 *
 * @param {string} platform Node platform identifier used only for the Windows suffix.
 * @returns {{native: string, wasi: string, manifest: string, root: string}} Conventional paths.
 */
export const getArtifactPaths = (platform = process.platform) => ({
  root: ARTIFACT_ROOT,
  manifest: path.join(ARTIFACT_ROOT, "manifest.json"),
  native: path.join(ARTIFACT_ROOT, "native", platform === "win32" ? "pannonico.exe" : "pannonico"),
  wasi: path.join(ARTIFACT_ROOT, "pannonico.wasm"),
});

/**
 * inspectRegularFile walks one validated relative path without following symlink components.
 *
 * The walk starts at the real artifact root, requires directory intermediates and a regular final
 * file, then confirms the final real path remains contained. Missing components use a typed error
 * so only a missing native member can trigger launcher fallback.
 *
 * @param {string} artifactRoot Package artifact root.
 * @param {string} relativePath Already schema-validated relative path.
 * @param {string} label Error context.
 * @param {{lstat?: typeof lstat, realpath?: typeof realpath}} dependencies Testable filesystem boundary.
 * @returns {Promise<{path: string, information: import("node:fs").Stats}>} Real selected path and metadata.
 */
const inspectRegularFile = async (artifactRoot, relativePath, label, dependencies = {}) => {
  const inspect = dependencies.lstat ?? lstat;
  const resolveRealPath = dependencies.realpath ?? realpath;
  const realRoot = await resolveRealPath(path.resolve(artifactRoot));
  const segments = validateArtifactPath(relativePath, `${label} path`);
  let selected = realRoot;
  let information;
  for (const [index, segment] of segments.entries()) {
    selected = path.join(selected, segment);
    try {
      information = await inspect(selected);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new ArtifactMissingError(label, error);
      }
      throw new Error(`${label} could not be inspected`, { cause: error });
    }
    if (information.isSymbolicLink()) throw new Error(`${label} path contains a symlink`);
    if (index < segments.length - 1 && !information.isDirectory()) {
      throw new Error(`${label} path contains a non-directory component`);
    }
  }
  if (!information?.isFile()) throw new Error(`${label} must be a regular file`);
  const realSelected = await resolveRealPath(selected);
  const relative = path.relative(realRoot, realSelected);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} escapes the artifact root`);
  }
  return { path: realSelected, information };
};

/**
 * readArtifactManifest safely reads and validates the package commit-point metadata.
 *
 * The manifest itself must be a regular non-symlink file beneath the real artifact root. Parse and
 * schema errors are wrapped with launcher context while preserving the underlying cause.
 *
 * @param {string} artifactRoot Package artifact root.
 * @param {object} dependencies Optional filesystem overrides for focused tests.
 * @returns {Promise<Record<string, unknown>>} Validated manifest.
 */
export const readArtifactManifest = async (artifactRoot = ARTIFACT_ROOT, dependencies = {}) => {
  try {
    const selected = await inspectRegularFile(
      artifactRoot,
      "manifest.json",
      "artifact manifest",
      dependencies,
    );
    const bytes = await (dependencies.readFile ?? readFile)(selected.path, "utf8");
    return validateManifest(JSON.parse(bytes));
  } catch (error) {
    throw new Error(
      `Invalid Pannonico artifact manifest: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

/**
 * verifyArtifactMember validates one selected member's path, target, mode, and exact bytes.
 *
 * Runtime callers pass an expected native target for host compatibility. Package verification omits
 * it so both cross-host members can be checked without pretending the package runs on that host.
 * Native execute-bit enforcement follows the validated artifact target, not the verifier host, so
 * Windows payloads remain portable and POSIX payloads remain executable. Only this selected member
 * is opened and hashed.
 *
 * @param {Record<string, unknown>} manifest Validated artifact manifest.
 * @param {"native" | "wasi"} kind Selected member kind.
 * @param {{artifactRoot?: string, expectedTarget?: string, readFile?: typeof readFile, lstat?: typeof lstat, realpath?: typeof realpath}} options Selection context.
 * @returns {Promise<{path: string, record: Record<string, unknown>}>} Verified executable path and record.
 */
export const verifyArtifactMember = async (manifest, kind, options = {}) => {
  const record = manifest.artifacts[kind === "native" ? 0 : 1];
  const label = `${kind} artifact`;
  if (options.expectedTarget !== undefined && record.target !== options.expectedTarget) {
    throw new Error(
      `${label} target mismatch: expected ${options.expectedTarget}, received ${record.target}`,
    );
  }
  const selected = await inspectRegularFile(
    options.artifactRoot ?? ARTIFACT_ROOT,
    record.path,
    label,
    options,
  );
  if (
    kind === "native" &&
    !record.target.startsWith("windows-") &&
    (selected.information.mode & 0o111) === 0
  ) {
    throw new Error("native artifact is not executable");
  }
  const bytes = await (options.readFile ?? readFile)(selected.path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== record.sha256) throw new Error(`${label} checksum mismatch`);
  return { path: selected.path, record };
};

/**
 * verifyPackageArtifacts enforces the stronger package-time rule that both members are present.
 *
 * The package dry-run checker calls this after Go commits a fresh pair. No host-target check applies
 * because package payload integrity is independent of the machine running the verification.
 *
 * @param {string} artifactRoot Package artifact root.
 * @returns {Promise<Record<string, unknown>>} Validated manifest after both byte checks pass.
 */
export const verifyPackageArtifacts = async (artifactRoot = ARTIFACT_ROOT) => {
  const manifest = await readArtifactManifest(artifactRoot);
  await verifyArtifactMember(manifest, "native", { artifactRoot });
  await verifyArtifactMember(manifest, "wasi", { artifactRoot });
  return manifest;
};
