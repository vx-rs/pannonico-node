import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { prepareWasiInvocation, runWasiExecutable } from "../lib/run-wasi.js";

test("scopes a build to one project and only SOURCE_DATE_EPOCH", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-wasi-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    const invocation = await prepareWasiInvocation(
      ["build", "--pages", "pages", "--report-json", join(project, "report.json"), project],
      { environment: { SOURCE_DATE_EPOCH: "123", SECRET: "hidden" } },
    );
    assert.deepEqual(invocation.env, { SOURCE_DATE_EPOCH: "123" });
    assert.deepEqual(invocation.preopens, { "/project": project });
    assert.deepEqual(invocation.args, [
      "build",
      "--pages",
      "pages",
      "--report-json",
      "/project/report.json",
      "/project",
    ]);
    const dotted = await prepareWasiInvocation(
      ["build", "--report-json", join(project, "..cache", "report.json"), project],
      { environment: {} },
    );
    assert.deepEqual(dotted.args, [
      "build",
      "--report-json",
      "/project/..cache/report.json",
      "/project",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects broad preopens and project-external absolute paths", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-wasi-"));
  try {
    await assert.rejects(prepareWasiInvocation(["build", resolve("/")]), /filesystem root/);
    await assert.rejects(
      prepareWasiInvocation(["build", "--out", join(root, "outside"), join(root, "missing")]),
      /ENOENT/,
    );
    mkdirSync(join(root, "site"));
    await assert.rejects(
      prepareWasiInvocation(["build", "--out", join(root, "outside"), join(root, "site")]),
      /outside the WASI project root/,
    );
    await assert.rejects(
      prepareWasiInvocation(["build", "--unknown", join(root, "site")]),
      /unknown build option/,
    );
    if (process.platform !== "win32") {
      const rootLink = join(root, "root-link");
      symlinkSync(resolve("/"), rootLink);
      await assert.rejects(prepareWasiInvocation(["build", rootLink]), /symlink/);

      const siteLink = join(root, "site-link");
      symlinkSync(join(root, "site"), siteLink);
      await assert.rejects(prepareWasiInvocation(["build", siteLink]), /symlink/);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("creates a scaffold root before preopening it", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-wasi-"));
  const project = join(root, "new-site");
  try {
    const invocation = await prepareWasiInvocation(["scaffold", "--vite", project]);
    assert.deepEqual(invocation.args, ["scaffold", "--vite", "/project"]);
    assert.deepEqual(invocation.preopens, { "/project": project });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("forwards build feature flags to the selected edition", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-node-wasi-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    const invocation = await prepareWasiInvocation(["build", "--minify", project], {
      environment: {},
    });
    assert.deepEqual(invocation.args, ["build", "--minify", "/project"]);
    assert.deepEqual(invocation.preopens, { "/project": project });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runs preview1 with inherited stream descriptors and exact guest status", async () => {
  let configuration;
  let imports;
  class FakeWasi {
    constructor(value) {
      configuration = value;
      this.wasiImport = { test: true };
    }
    start(instance) {
      assert.deepEqual(instance, { module: true });
      return 31;
    }
  }
  const status = await runWasiExecutable("/verified/pannonico.wasm", ["--version"], {
    environment: {},
    stdin: { fd: 10 },
    stdout: { fd: 11 },
    stderr: { fd: 12 },
    Wasi: FakeWasi,
    readModule: async () => Buffer.from("module"),
    compile: async () => ({ compiled: true }),
    instantiate: async (module, value) => {
      assert.deepEqual(module, { compiled: true });
      imports = value;
      return { module: true };
    },
  });
  assert.equal(status, 31);
  assert.deepEqual(configuration, {
    version: "preview1",
    args: ["pannonico", "--version"],
    env: {},
    preopens: {},
    stdin: 10,
    stdout: 11,
    stderr: 12,
    returnOnExit: true,
  });
  assert.deepEqual(imports, { wasi_snapshot_preview1: { test: true } });
});
