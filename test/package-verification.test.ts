import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PackageUnavailableError, verifyPackage } from "../lib/package-verification.js";
import { NATIVE_TARGETS, WASI_TARGET } from "../lib/targets.js";
import { releasePackageManifest } from "../scripts/release-package.ts";

const createPackage = (contract = NATIVE_TARGETS[0]) => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-package-"));
  const payloadPath = join(root, contract.payload);
  const parts = contract.payload.split("/");
  if (parts.length > 1) {
    mkdirSync(join(root, parts[0]), { recursive: true });
  }
  const payload = Buffer.from("verified payload\n");
  writeFileSync(payloadPath, payload, { mode: 0o755 });
  chmodSync(payloadPath, 0o755);
  const manifest = {
    name: contract.packageName,
    version: "1.2.3",
    pannonico: {
      schemaVersion: 1,
      edition: "free",
      target: contract.target,
      payload: contract.payload,
    },
    ...(contract.platform
      ? {
          os: [contract.platform],
          cpu: [contract.architecture],
        }
      : {}),
  };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(
    join(root, "SHA256SUMS"),
    `${createHash("sha256").update(payload).digest("hex")}  ${contract.payload}\n`,
  );
  return {
    manifest,
    manifestPath: join(root, "package.json"),
    payloadPath,
    remove: () => rmSync(root, { force: true, recursive: true }),
    root,
  };
};

test("selects the exact six native contracts and regular WASI identity", async () => {
  const source = (await import("../package.json", { with: { type: "json" } })).default;
  const packageJson = releasePackageManifest(source, "1.2.3");
  assert.equal(NATIVE_TARGETS.length, 6);
  assert.equal(new Set(NATIVE_TARGETS.map(({ target }) => target)).size, 6);
  assert.deepEqual(
    Object.keys(packageJson.optionalDependencies).sort(),
    NATIVE_TARGETS.map(({ packageName }) => packageName).sort(),
  );
  assert.equal(source.private, true);
  assert.equal(packageJson.private, undefined);
  assert.deepEqual(packageJson.dependencies, { [WASI_TARGET.packageName]: packageJson.version });
  assert.equal(
    [
      ...Object.values(packageJson.optionalDependencies),
      ...Object.values(packageJson.dependencies),
    ].every((version) => version === packageJson.version),
    true,
  );
  assert.equal(packageJson.scripts.preinstall, undefined);
  assert.equal(packageJson.scripts.install, undefined);
  assert.equal(packageJson.scripts.postinstall, undefined);
});

test("verifies exact metadata, checksum, and native executable mode", () => {
  const fixture = createPackage();
  try {
    assert.equal(
      verifyPackage(NATIVE_TARGETS[0], "1.2.3", {
        resolvePackage: () => fixture.manifestPath,
      }),
      fixture.payloadPath,
    );
  } finally {
    fixture.remove();
  }
});

test("distinguishes unavailable packages from installed integrity failures", () => {
  assert.throws(
    () =>
      verifyPackage(NATIVE_TARGETS[0], "1.2.3", {
        resolvePackage: () => {
          throw new Error();
        },
      }),
    PackageUnavailableError,
  );
  for (const [label, mutate, expected] of [
    [
      "version",
      (fixture) => {
        fixture.manifest.version = "1.2.4";
      },
      /does not match launcher/,
    ],
    [
      "edition",
      (fixture) => {
        fixture.manifest.pannonico.edition = "pro";
      },
      /edition, target, or payload/,
    ],
    [
      "target",
      (fixture) => {
        fixture.manifest.pannonico.target = "linux-arm64";
      },
      /edition, target, or payload/,
    ],
    [
      "install script",
      (fixture) => {
        fixture.manifest.scripts = { install: "unexpected" };
      },
      /must not declare scripts or runtime dependencies/,
    ],
  ]) {
    const fixture = createPackage();
    try {
      mutate(fixture);
      writeFileSync(join(fixture.root, "package.json"), `${JSON.stringify(fixture.manifest)}\n`);
      assert.throws(
        () =>
          verifyPackage(NATIVE_TARGETS[0], "1.2.3", { resolvePackage: () => fixture.manifestPath }),
        expected,
        label,
      );
    } finally {
      fixture.remove();
    }
  }
});

test("rejects payload and checksum tampering and validates WASI metadata", () => {
  const native = createPackage();
  try {
    writeFileSync(native.payloadPath, "tampered\n", { mode: 0o755 });
    assert.throws(
      () =>
        verifyPackage(NATIVE_TARGETS[0], "1.2.3", { resolvePackage: () => native.manifestPath }),
      /checksum does not match/,
    );
  } finally {
    native.remove();
  }

  const wasi = createPackage(WASI_TARGET);
  try {
    assert.equal(
      verifyPackage(WASI_TARGET, "1.2.3", { resolvePackage: () => wasi.manifestPath }),
      wasi.payloadPath,
    );
    wasi.manifest.os = ["linux"];
    writeFileSync(join(wasi.root, "package.json"), `${JSON.stringify(wasi.manifest)}\n`);
    assert.throws(
      () => verifyPackage(WASI_TARGET, "1.2.3", { resolvePackage: () => wasi.manifestPath }),
      /must not claim a native target/,
    );
  } finally {
    wasi.remove();
  }
});
