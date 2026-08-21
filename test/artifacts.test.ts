// Imports
// -----------------------------------------------------------------------------

// Node.js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Internal
import {
  ArtifactMissingError,
  calculatePairId,
  canonicalJSONString,
  expectedNativeTarget,
  getArtifactPaths,
  readArtifactManifest,
  validateManifest,
  verifyArtifactMember,
  verifyPackageArtifacts,
} from "../lib/artifacts.js";

// Fixtures
// -----------------------------------------------------------------------------

const NATIVE_BYTES = Buffer.from("native fixture\n");
const WASI_BYTES = Buffer.from("wasi fixture\n");
// Canonicalize platform aliases such as macOS /var and Windows 8.3 names so
// fixture identity matches the production realpath confinement boundary.
const TEST_TEMP_ROOT = realpathSync.native(os.tmpdir());
const FIXTURE_NATIVE_PATH =
  process.platform === "win32" ? "native/pannonico.exe" : "native/pannonico";
const FIXTURE_NATIVE_TARGET =
  process.platform === "win32"
    ? (expectedNativeTarget(process.platform, process.arch) ?? "windows-amd64")
    : "linux-amd64";

/**
 * digest computes deterministic fixture checksums with the production algorithm.
 *
 * @param {Buffer} bytes Exact fixture member bytes.
 * @returns {string} Lowercase SHA-256 digest.
 */
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * createManifest returns a deterministic valid Linux pair with canonical identity.
 *
 * Tests mutate a clone and explicitly rebind pairId when they need to isolate schema or selected
 * member behavior from canonical-identity rejection.
 *
 * @returns {Record<string, unknown>} Valid schema-v1 manifest.
 */
const createManifest = () => {
  const manifest = {
    schemaVersion: 1,
    product: "pannonico",
    productVersion: "1.2.3-test",
    sourceRevision: "development",
    edition: "free",
    pairId: "0".repeat(64),
    artifacts: [
      {
        kind: "native",
        path: "native/pannonico",
        target: "linux-amd64",
        sha256: digest(NATIVE_BYTES),
        capabilities: [
          { name: "atomic-output", version: 1 },
          { name: "vite-process", version: 1 },
        ],
      },
      {
        kind: "wasi",
        path: "pannonico.wasm",
        target: "wasip1-wasm",
        sha256: digest(WASI_BYTES),
        capabilities: [{ name: "atomic-output", version: 1 }],
      },
    ],
  };
  manifest.pairId = calculatePairId(manifest);
  return manifest;
};

/**
 * bindPairId updates a mutated fixture so later validation reaches the intended rule.
 *
 * @param {Record<string, unknown>} manifest Mutated schema candidate.
 * @returns {Record<string, unknown>} Same object with a matching canonical pair ID.
 */
const bindPairId = (manifest) => {
  manifest.pairId = calculatePairId(manifest);
  return manifest;
};

/**
 * createArtifactFixture writes one complete deterministic pair beneath a disposable root.
 *
 * @returns {{root: string, manifest: Record<string, unknown>}} Fixture root and metadata.
 */
const createArtifactFixture = () => {
  const root = mkdtempSync(path.join(TEST_TEMP_ROOT, "pannonico-node-artifact-"));
  mkdirSync(path.join(root, "native"));
  writeFileSync(path.join(root, FIXTURE_NATIVE_PATH), NATIVE_BYTES, { mode: 0o755 });
  writeFileSync(path.join(root, "pannonico.wasm"), WASI_BYTES);
  const manifest = createManifest();
  manifest.artifacts[0].path = FIXTURE_NATIVE_PATH;
  manifest.artifacts[0].target = FIXTURE_NATIVE_TARGET;
  bindPairId(manifest);
  writeFileSync(path.join(root, "manifest.json"), canonicalJSONString(manifest));
  return { root, manifest };
};

// Paths and identity
// -----------------------------------------------------------------------------

test("uses fixed package paths and exact host target mapping", () => {
  const artifactRoot = fileURLToPath(new URL("../artifacts/", import.meta.url));
  assert.equal(getArtifactPaths("linux").native, path.join(artifactRoot, "native", "pannonico"));
  assert.equal(
    getArtifactPaths("win32").native,
    path.join(artifactRoot, "native", "pannonico.exe"),
  );
  assert.equal(getArtifactPaths("linux").wasi, path.join(artifactRoot, "pannonico.wasm"));
  assert.equal(getArtifactPaths("linux").manifest, path.join(artifactRoot, "manifest.json"));
  assert.equal(expectedNativeTarget("darwin", "x64"), "darwin-amd64");
  assert.equal(expectedNativeTarget("win32", "arm64"), "windows-arm64");
  assert.equal(expectedNativeTarget("aix", "ppc64"), undefined);
});

test("validates exact schema, canonical serialization, and pair identity", () => {
  const manifest = createManifest();
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/manifest-v1-free-linux.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.deepEqual(manifest, fixture);
  assert.equal(canonicalJSONString(manifest), canonicalJSONString(fixture));
  for (const mutate of [
    (value) => (value.artifacts[0].path = "nested/native/pannonico"),
    (value) => (value.artifacts[0].sha256 = "f".repeat(64)),
  ]) {
    const changedIdentity = structuredClone(manifest);
    mutate(changedIdentity);
    assert.notEqual(calculatePairId(changedIdentity), manifest.pairId);
  }
  assert.equal(validateManifest(manifest), manifest);
  const revisionBound = structuredClone(manifest);
  revisionBound.sourceRevision = "a".repeat(40);
  bindPairId(revisionBound);
  assert.equal(validateManifest(revisionBound), revisionBound);
  assert.equal(canonicalJSONString({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  const tampered = structuredClone(manifest);
  tampered.productVersion = "9.9.9";
  assert.throws(() => validateManifest(tampered), /pairId mismatch/);
  const extra = structuredClone(manifest);
  extra.unexpected = true;
  assert.throws(() => validateManifest(extra), /exactly/);
});

test("rejects revision, artifact order, path, target, and capability shape errors", () => {
  const cases = [
    ["revision", (value) => (value.sourceRevision = "ABC"), /sourceRevision/],
    ["artifact order", (value) => value.artifacts.reverse(), /native artifact.kind/],
    ["parent path", (value) => (value.artifacts[0].path = "native/../pannonico"), /unsafe path/],
    ["backslash path", (value) => (value.artifacts[0].path = "native\\pannonico"), /forward-slash/],
    ["WASI path", (value) => (value.artifacts[1].path = "portable.wasm"), /WASI artifact path/],
    ["WASI target", (value) => (value.artifacts[1].target = "js-wasm"), /WASI artifact target/],
    ["native target", (value) => (value.artifacts[0].target = "plan9-amd64"), /unsupported/],
    [
      "capability version",
      (value) => (value.artifacts[0].capabilities[0].version = 0),
      /positive integer/,
    ],
    ["capability order", (value) => value.artifacts[0].capabilities.reverse(), /strictly ordered/],
    ["capability field", (value) => (value.artifacts[0].capabilities[0].extra = true), /exactly/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const manifest = createManifest();
    mutate(manifest);
    bindPairId(manifest);
    assert.throws(() => validateManifest(manifest), pattern, name);
  }
});

// Selected member validation
// -----------------------------------------------------------------------------

test("loads a safe manifest and verifies exact selected member bytes", async () => {
  const fixture = createArtifactFixture();
  try {
    const manifest = await readArtifactManifest(fixture.root);
    const native = await verifyArtifactMember(manifest, "native", {
      artifactRoot: fixture.root,
      expectedTarget: FIXTURE_NATIVE_TARGET,
    });
    const wasi = await verifyArtifactMember(manifest, "wasi", { artifactRoot: fixture.root });
    assert.equal(native.path, path.join(fixture.root, FIXTURE_NATIVE_PATH));
    assert.equal(wasi.path, path.join(fixture.root, "pannonico.wasm"));
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("rejects selected checksum, target, and missing-member failures distinctly", async () => {
  const fixture = createArtifactFixture();
  try {
    const manifest = await readArtifactManifest(fixture.root);
    writeFileSync(path.join(fixture.root, FIXTURE_NATIVE_PATH), "tampered", { mode: 0o755 });
    await assert.rejects(
      verifyArtifactMember(manifest, "native", {
        artifactRoot: fixture.root,
        expectedTarget: FIXTURE_NATIVE_TARGET,
      }),
      /checksum mismatch/,
    );
    writeFileSync(path.join(fixture.root, FIXTURE_NATIVE_PATH), NATIVE_BYTES, { mode: 0o755 });
    await assert.rejects(
      verifyArtifactMember(manifest, "native", {
        artifactRoot: fixture.root,
        expectedTarget: "linux-arm64",
      }),
      /target mismatch/,
    );
    rmSync(path.join(fixture.root, FIXTURE_NATIVE_PATH));
    await assert.rejects(
      verifyArtifactMember(manifest, "native", { artifactRoot: fixture.root }),
      ArtifactMissingError,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("derives native execute-bit enforcement from the artifact target", async () => {
  const windowsManifest = createManifest();
  windowsManifest.artifacts[0].path = "native/pannonico.exe";
  windowsManifest.artifacts[0].target = "windows-amd64";
  bindPairId(windowsManifest);
  validateManifest(windowsManifest);
  const virtualFilesystem = {
    lstat: async (selectedPath) => ({
      mode: 0o644,
      isSymbolicLink: () => false,
      isDirectory: () => path.basename(selectedPath) === "native",
      isFile: () => path.basename(selectedPath) !== "native",
    }),
    realpath: async (selectedPath) => selectedPath,
    readFile: async () => NATIVE_BYTES,
  };
  await verifyArtifactMember(windowsManifest, "native", {
    artifactRoot: path.resolve("virtual-artifacts"),
    expectedTarget: "windows-amd64",
    platform: "linux",
    ...virtualFilesystem,
  });

  const posixManifest = createManifest();
  validateManifest(posixManifest);
  await assert.rejects(
    verifyArtifactMember(posixManifest, "native", {
      artifactRoot: path.resolve("virtual-artifacts"),
      expectedTarget: "linux-amd64",
      platform: "win32",
      ...virtualFilesystem,
    }),
    /not executable/,
  );
});

test("rejects symlink components, symlink files, and nonregular selected members", async () => {
  if (process.platform === "win32") return;
  const fixture = createArtifactFixture();
  const external = mkdtempSync(path.join(TEST_TEMP_ROOT, "pannonico-node-external-"));
  try {
    const manifest = await readArtifactManifest(fixture.root);
    rmSync(path.join(fixture.root, "native"), { recursive: true });
    mkdirSync(path.join(external, "native"));
    writeFileSync(path.join(external, "native", "pannonico"), NATIVE_BYTES, { mode: 0o755 });
    symlinkSync(path.join(external, "native"), path.join(fixture.root, "native"));
    await assert.rejects(
      verifyArtifactMember(manifest, "native", { artifactRoot: fixture.root, platform: "linux" }),
      /contains a symlink/,
    );

    rmSync(path.join(fixture.root, "native"));
    mkdirSync(path.join(fixture.root, "native"));
    symlinkSync(
      path.join(external, "native", "pannonico"),
      path.join(fixture.root, "native", "pannonico"),
    );
    await assert.rejects(
      verifyArtifactMember(manifest, "native", { artifactRoot: fixture.root, platform: "linux" }),
      /contains a symlink/,
    );

    rmSync(path.join(fixture.root, "native", "pannonico"));
    mkdirSync(path.join(fixture.root, "native", "pannonico"));
    await assert.rejects(
      verifyArtifactMember(manifest, "native", { artifactRoot: fixture.root, platform: "linux" }),
      /regular file/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
});

test("runtime tolerates an unselected missing member while package verification requires both", async () => {
  const fixture = createArtifactFixture();
  try {
    const manifest = await readArtifactManifest(fixture.root);
    rmSync(path.join(fixture.root, "pannonico.wasm"));
    await verifyArtifactMember(manifest, "native", {
      artifactRoot: fixture.root,
      expectedTarget: FIXTURE_NATIVE_TARGET,
    });
    await assert.rejects(verifyPackageArtifacts(fixture.root), /wasi artifact is missing/);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test("rejects missing, malformed, and symlinked manifest commit points", async () => {
  const root = mkdtempSync(path.join(TEST_TEMP_ROOT, "pannonico-node-manifest-"));
  try {
    await assert.rejects(readArtifactManifest(root), /manifest.*missing/i);
    writeFileSync(path.join(root, "manifest.json"), "{");
    await assert.rejects(readArtifactManifest(root), /Invalid Pannonico artifact manifest/);
    if (process.platform !== "win32") {
      const target = path.join(root, "target.json");
      writeFileSync(target, canonicalJSONString(createManifest()));
      rmSync(path.join(root, "manifest.json"));
      symlinkSync(target, path.join(root, "manifest.json"));
      await assert.rejects(readArtifactManifest(root), /contains a symlink/);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
