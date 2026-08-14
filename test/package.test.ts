// Imports
// -----------------------------------------------------------------------------

// Node.js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Internal
import { calculatePairId, canonicalJSONString } from "../lib/artifacts.js";
import { verifyPackageDryRun } from "../scripts/verify-package.mjs";

// Fixtures
// -----------------------------------------------------------------------------

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_NATIVE_PATH =
  process.platform === "win32" ? "native/pannonico.exe" : "native/pannonico";
const PACKAGE_NATIVE_TARGET = process.platform === "win32" ? "windows-amd64" : "linux-amd64";

/**
 * checksum computes one deterministic package-fixture member digest.
 *
 * @param {Buffer} bytes Exact member bytes.
 * @returns {string} Lowercase SHA-256 digest.
 */
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * createPackageFixture copies package-owned source surfaces and writes one synthetic verified pair.
 *
 * The disposable package avoids reading or replacing a developer's ignored local artifacts. Its
 * deterministic members test npm inclusion and both-member enforcement without checking binaries in.
 *
 * @returns {string} Disposable package root.
 */
const createPackageFixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pannonico-package-"));
  for (const entry of [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "COMMERCIAL-LICENSE.md",
    "bin",
    "lib",
    "demo/package.json",
  ]) {
    cpSync(path.join(REPOSITORY_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  const native = Buffer.from("native package fixture\n");
  const wasi = Buffer.from("wasi package fixture\n");
  mkdirSync(path.join(root, "artifacts", "native"), { recursive: true });
  writeFileSync(path.join(root, "artifacts", PACKAGE_NATIVE_PATH), native, { mode: 0o755 });
  writeFileSync(path.join(root, "artifacts", "pannonico.wasm"), wasi);
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
        path: PACKAGE_NATIVE_PATH,
        target: PACKAGE_NATIVE_TARGET,
        sha256: checksum(native),
        capabilities: [{ name: "atomic-output", version: 1 }],
      },
      {
        kind: "wasi",
        path: "pannonico.wasm",
        target: "wasip1-wasm",
        sha256: checksum(wasi),
        capabilities: [{ name: "atomic-output", version: 1 }],
      },
    ],
  };
  manifest.pairId = calculatePairId(manifest);
  writeFileSync(path.join(root, "artifacts", "manifest.json"), canonicalJSONString(manifest));
  return root;
};

// Package payload
// -----------------------------------------------------------------------------

test("captures npm pack JSON under a silent lifecycle and validates the payload", async () => {
  const root = createPackageFixture();
  const priorLoglevel = process.env.npm_config_loglevel;
  const priorSilent = process.env.npm_config_silent;
  try {
    // npm lifecycle silence must not suppress the child pack JSON that verification parses.
    process.env.npm_config_loglevel = "silent";
    process.env.npm_config_silent = "true";
    mkdirSync(path.join(root, "coverage"));
    writeFileSync(path.join(root, "coverage", "ignored.txt"), "ignored");
    mkdirSync(path.join(root, "demo", "dist"), { recursive: true });
    writeFileSync(path.join(root, "demo", "dist", "ignored.txt"), "ignored");
    const files = await verifyPackageDryRun(root);
    assert.deepEqual(
      files.filter((file) => file.startsWith("artifacts/")),
      [
        "artifacts/manifest.json",
        `artifacts/${PACKAGE_NATIVE_PATH}`,
        "artifacts/pannonico.wasm",
      ].sort(),
    );
    assert.equal(
      files.some((file) => file.startsWith("coverage/")),
      false,
    );
    assert.equal(
      files.some((file) => file.startsWith("demo/dist/")),
      false,
    );
  } finally {
    if (priorLoglevel === undefined) delete process.env.npm_config_loglevel;
    else process.env.npm_config_loglevel = priorLoglevel;
    if (priorSilent === undefined) delete process.env.npm_config_silent;
    else process.env.npm_config_silent = priorSilent;
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects an npm-included artifact that is not bound by the manifest", async () => {
  const root = createPackageFixture();
  const stalePath = "artifacts/stale/pannonico";
  try {
    mkdirSync(path.join(root, "artifacts", "stale"));
    writeFileSync(path.join(root, ...stalePath.split("/")), "stale artifact\n");
    await assert.rejects(verifyPackageDryRun(root), {
      message: `npm package includes unbound artifact ${stalePath}`,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
