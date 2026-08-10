import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getArtifactPaths, inspectArtifact } from "../lib/artifacts.js";

// Paths
// -----------------------------------------------------------------------------

test("uses one fixed native path and one fixed WASI path", () => {
  const artifactRoot = fileURLToPath(new URL("../artifacts/", import.meta.url));
  assert.equal(getArtifactPaths("linux").native, join(artifactRoot, "native", "pannonico"));
  assert.equal(getArtifactPaths("win32").native, join(artifactRoot, "native", "pannonico.exe"));
  assert.equal(getArtifactPaths("linux").wasi, join(artifactRoot, "pannonico.wasm"));
});

// Validation
// -----------------------------------------------------------------------------

test("accepts regular artifacts, reports absence, and rejects unsafe files", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-artifact-"));
  const executable = join(root, "pannonico");
  const missing = join(root, "missing");
  const link = join(root, "pannonico-link");
  try {
    writeFileSync(executable, "test");
    chmodSync(executable, 0o755);
    assert.equal(
      inspectArtifact(executable, "test artifact", { executable: true, platform: "linux" }),
      true,
    );
    assert.equal(inspectArtifact(missing, "missing artifact"), false);
    if (process.platform !== "win32") {
      symlinkSync(executable, link);
      assert.throws(() => inspectArtifact(link, "linked artifact"), /non-symlink/);
    }
    chmodSync(executable, 0o644);
    assert.equal(
      inspectArtifact(executable, "Windows test artifact", {
        executable: true,
        platform: "win32",
      }),
      true,
    );
    assert.throws(
      () => inspectArtifact(executable, "test artifact", { executable: true, platform: "linux" }),
      /not executable/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
