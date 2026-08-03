import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NATIVE_TARGETS, WASI_TARGET } from "../lib/targets.js";
import { expectedTarballs, packageLocalRelease } from "../scripts/package-local-release.ts";
import {
  releasePackageManifest,
  updateReleaseFiles,
  validateVersion,
} from "../scripts/release-package.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("builds the exact publishable dependency graph without mutating its source", () => {
  const source = { name: "@vx.rs/pannonico", version: "0.0.0", private: true };
  const manifest = releasePackageManifest(source, "1.2.3-rc.1");
  assert.deepEqual(source, { name: "@vx.rs/pannonico", version: "0.0.0", private: true });
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.version, "1.2.3-rc.1");
  assert.deepEqual(manifest.dependencies, { [WASI_TARGET.packageName]: "1.2.3-rc.1" });
  assert.deepEqual(
    manifest.optionalDependencies,
    Object.fromEntries(NATIVE_TARGETS.map(({ packageName }) => [packageName, "1.2.3-rc.1"])),
  );
  assert.throws(() => validateVersion("01.2.3"), /Invalid release version/);
});

test("updates only exact release metadata in a controlled checkout", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-release-package-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"name":"@vx.rs/pannonico","version":"0.0.0","private":true}\n',
    );
    writeFileSync(
      join(root, "package-lock.json"),
      '{"name":"@vx.rs/pannonico","version":"0.0.0","packages":{"":{"name":"@vx.rs/pannonico","version":"0.0.0","private":true}}}\n',
    );
    updateReleaseFiles(root, "2.0.0");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(manifest.version, "2.0.0");
    assert.equal(manifest.private, undefined);
    assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[""].optionalDependencies, manifest.optionalDependencies);
    assert.equal(lock.packages[""].private, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("names exactly one wrapper, six native, and one WASI local tarball", () => {
  assert.deepEqual(expectedTarballs("1.2.3"), [
    "pannonico-1.2.3.tgz",
    "pannonico-bin-linux-x64-1.2.3.tgz",
    "pannonico-bin-linux-arm64-1.2.3.tgz",
    "pannonico-bin-darwin-x64-1.2.3.tgz",
    "pannonico-bin-darwin-arm64-1.2.3.tgz",
    "pannonico-bin-win32-x64-1.2.3.tgz",
    "pannonico-bin-win32-arm64-1.2.3.tgz",
    "pannonico-wasi-1.2.3.tgz",
  ]);
});

test("does not replace existing output when binary validation fails", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-local-package-"));
  const output = join(root, "npm");
  mkdirSync(output);
  writeFileSync(join(output, "preserved.txt"), "preserved\n");
  try {
    assert.throws(
      () =>
        packageLocalRelease(
          { binaries: join(root, "binaries"), output, version: "1.2.3" },
          { runCommand: () => ({ status: 1, stderr: "invalid release", stdout: "" }) },
        ),
      /Binary release validation failed/,
    );
    assert.equal(readFileSync(join(output, "preserved.txt"), "utf8"), "preserved\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects package output inside a protected repository or at a regular file", () => {
  assert.throws(
    () =>
      packageLocalRelease({
        binaries: join(REPOSITORY_ROOT, "fixtures", "binaries"),
        output: join(REPOSITORY_ROOT, "npm"),
        repository: REPOSITORY_ROOT,
        version: "1.2.3",
      }),
    /replace protected repository/,
  );
  assert.throws(
    () =>
      packageLocalRelease({
        binaries: join(REPOSITORY_ROOT, "fixtures", "binaries"),
        output: join(REPOSITORY_ROOT, "..cache", "npm"),
        repository: REPOSITORY_ROOT,
        version: "1.2.3",
      }),
    /replace protected repository/,
  );

  const root = mkdtempSync(join(os.tmpdir(), "pannonico-local-package-file-"));
  const output = join(root, "npm");
  writeFileSync(output, "preserve me\n");
  try {
    assert.throws(
      () => packageLocalRelease({ binaries: join(root, "binaries"), output, version: "1.2.3" }),
      /output is not a real directory/,
    );
    assert.equal(readFileSync(output, "utf8"), "preserve me\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("stages and replaces one exact package set from a validated public manifest", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-local-package-success-"));
  const binaries = join(root, "pannonico-binaries");
  const output = join(root, "npm");
  mkdirSync(binaries);
  mkdirSync(output);
  writeFileSync(join(output, "old.txt"), "old\n");
  writeFileSync(
    join(binaries, "release-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, sourceTag: "v1.2.3", targets: Array(7), version: "1.2.3" })}\n`,
  );
  for (const contract of [...NATIVE_TARGETS, WASI_TARGET]) {
    const directory =
      contract.target === "wasi" ? "wasi" : contract.target.replace(/^windows-/, "win32-");
    const packageRoot = join(binaries, "packages", directory);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: contract.packageName, version: "1.2.3", pannonico: { payload: contract.payload } })}\n`,
    );
  }

  let filenameIndex = 0;
  const runCommand = (command, args) => {
    if (command === process.execPath) return { status: 0, stderr: "", stdout: "validated\n" };
    const destination = args[args.indexOf("--pack-destination") + 1];
    const packageRoot = args.at(-1);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const filename = `packed-${filenameIndex++}.tgz`;
    writeFileSync(join(destination, filename), "tarball\n");
    const files =
      manifest.name === "@vx.rs/pannonico"
        ? [
            "COMMERCIAL-LICENSE.md",
            "LICENSE",
            "NOTICE",
            "README.md",
            "bin/pannonico.js",
            "lib/debug.js",
            "lib/launcher.js",
            "lib/package-verification.js",
            "lib/run-native.js",
            "lib/run-wasi.js",
            "lib/targets.js",
            "package.json",
          ]
        : [
            "COMMERCIAL-LICENSE.md",
            "LICENSE",
            "NOTICE",
            "README.md",
            "SHA256SUMS",
            manifest.pannonico.payload,
            "package.json",
          ];
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        [manifest.name]: {
          entryCount: files.length,
          filename,
          files: files.map((path) => ({ path })),
          name: manifest.name,
          version: "1.2.3",
        },
      }),
    };
  };
  try {
    assert.deepEqual(
      packageLocalRelease(
        { binaries, output, repository: REPOSITORY_ROOT, version: "1.2.3" },
        { runCommand },
      ),
      expectedTarballs("1.2.3").map((name) => join(output, name)),
    );
    assert.equal(filenameIndex, 8);
    assert.throws(() => readFileSync(join(output, "old.txt")), /ENOENT/);
    for (const name of expectedTarballs("1.2.3")) {
      assert.equal(readFileSync(join(output, name), "utf8"), "tarball\n");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
