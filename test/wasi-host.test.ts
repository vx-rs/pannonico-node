// Imports
// -----------------------------------------------------------------------------

// Node.js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat as inspectPath } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Internal
import { prepareWasiInvocation, runWasiExecutable } from "../lib/run-wasi.js";

// Canonicalize platform aliases such as macOS /var and Windows 8.3 names so
// fixture identity matches the production realpath confinement boundary.
const TEST_TEMP_ROOT = realpathSync.native(os.tmpdir());

test("scopes a build to one project and only SOURCE_DATE_EPOCH", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
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
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
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

test("rejects a missing scaffold root before canonical or WASI work", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const project = join(root, "new-site");
  const events = [];
  try {
    await assert.rejects(
      prepareWasiInvocation(["scaffold", "--vite", project], {
        lstat: async (selected) => {
          events.push("lstat");
          return inspectPath(selected);
        },
        realpath: async () => {
          events.push("realpath");
          return project;
        },
        stat: async () => {
          events.push("stat");
          return { isDirectory: () => true };
        },
      }),
      {
        message: `WASI scaffold root ${JSON.stringify(project)} must already exist as a directory`,
      },
    );
    assert.ok(events.length > 0);
    assert.equal(
      events.every((event) => event === "lstat"),
      true,
    );
    await assert.rejects(inspectPath(project), { code: "ENOENT" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("never invokes legacy mkdir after an ancestor is replaced", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const outside = join(root, "outside");
  const parent = join(root, "parent");
  const selected = join(parent, "leaf");
  mkdirSync(outside);
  mkdirSync(parent);
  let swapped = false;
  let created = false;
  try {
    await assert.rejects(
      prepareWasiInvocation(["scaffold", selected], {
        lstat: async (current) => {
          if (current === selected && !swapped) {
            rmSync(parent, { recursive: true });
            symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
            swapped = true;
          }
          return inspectPath(current);
        },
        mkdir: async () => {
          created = true;
          mkdirSync(selected, { recursive: true });
        },
      }),
      {
        message: `WASI scaffold root ${JSON.stringify(selected)} must already exist as a directory`,
      },
    );
    assert.equal(swapped, true);
    assert.equal(created, false);
    await assert.rejects(inspectPath(join(outside, "leaf")), { code: "ENOENT" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects a scaffold symlink ancestor without creating outside descendants", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const outside = join(root, "outside");
  const parent = join(root, "parent");
  const link = join(parent, "link");
  const selected = join(link, "leaf");
  mkdirSync(outside);
  mkdirSync(parent);
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  let created = false;
  try {
    await assert.rejects(
      prepareWasiInvocation(["scaffold", selected], {
        mkdir: async () => {
          created = true;
        },
      }),
      /contains a symlink/,
    );
    assert.equal(created, false);
    await assert.rejects(inspectPath(join(outside, "leaf")), { code: "ENOENT" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects a scaffold non-directory ancestor without host mutation", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const parent = join(root, "parent.txt");
  const selected = join(parent, "leaf");
  writeFileSync(parent, "not a directory\n");
  let created = false;
  try {
    await assert.rejects(
      prepareWasiInvocation(["scaffold", selected], {
        mkdir: async () => {
          created = true;
        },
      }),
      /contains a non-directory component/,
    );
    assert.equal(created, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("preopens a positional source parent and forwards new syntax", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const source = join(root, "article.md");
  const data = join(root, "external-data");
  writeFileSync(source, "# Article\n");
  mkdirSync(data);
  try {
    const invocation = await prepareWasiInvocation([
      "build",
      "--data",
      data,
      "--data-url",
      "https://example.test/one,two.yaml",
      "--data-url=https://example.test/navigation.json",
      source,
    ]);
    assert.deepEqual(invocation.preopens, { "/project": root });
    assert.deepEqual(invocation.args, [
      "build",
      "--data",
      "/project/external-data",
      "--data-url",
      "https://example.test/one,two.yaml",
      "--data-url",
      "https://example.test/navigation.json",
      "/project/article.md",
    ]);
    await assert.rejects(
      prepareWasiInvocation(["build", "--data", "../outside", source]),
      /outside the WASI project root/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("forwards the minimal scaffold mode", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const project = join(root, "minimal-site");
  mkdirSync(project);
  try {
    const invocation = await prepareWasiInvocation(["scaffold", "--min", project]);
    assert.deepEqual(invocation.args, ["scaffold", "--min", "/project"]);
    assert.deepEqual(invocation.preopens, { "/project": project });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("forwards build feature flags to the selected edition", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    for (const flag of ["--beautify", "--minify"]) {
      const invocation = await prepareWasiInvocation(["build", flag, project], {
        environment: {},
      });
      assert.deepEqual(invocation.args, ["build", flag, "/project"]);
      assert.deepEqual(invocation.preopens, { "/project": project });
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("forwards recognized build values without interpreting Go policy", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    for (const [optionArguments, forwarded] of [
      [
        ["--jobs", "-100"],
        ["--jobs", "-100"],
      ],
      [["--jobs=-100"], ["--jobs", "-100"]],
      [
        ["--max-output-workers", "-1"],
        ["--max-output-workers", "-1"],
      ],
      [["--max-output-workers=-1"], ["--max-output-workers", "-1"]],
      [
        ["--jobs", "-100", "--max-output-workers=-1"],
        ["--jobs", "-100", "--max-output-workers", "-1"],
      ],
      [
        ["--max-output-workers", "edition-defined"],
        ["--max-output-workers", "edition-defined"],
      ],
    ]) {
      const invocation = await prepareWasiInvocation(["build", ...optionArguments, project], {
        environment: {},
      });
      assert.deepEqual(invocation.args, ["build", ...forwarded, "/project"]);
      assert.deepEqual(invocation.preopens, { "/project": project });
    }
    for (const invalid of [
      ["build", "--jobs"],
      ["build", "--jobs=", project],
      ["build", "--max-output-workers", "", project],
    ]) {
      await assert.rejects(prepareWasiInvocation(invalid), /requires a value/);
    }
    await assert.rejects(
      prepareWasiInvocation(["build", "--unknown-workers", "-1", project]),
      /unknown build option/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects explicit empty project roots before filesystem or WASI work", async () => {
  const calls = [];
  const options = {
    cwd: resolve("fixture-cwd"),
    realpath: async () => calls.push("realpath"),
    stat: async () => calls.push("stat"),
    Wasi: class {
      /** constructor records an invalid attempt to construct WASI before root validation. */
      constructor() {
        calls.push("WASI");
      }
    },
    readModule: async () => {
      calls.push("readModule");
      return Buffer.from("module");
    },
    compile: async () => {
      calls.push("compile");
      return { compiled: true };
    },
  };
  for (const invocation of [
    ["build", ""],
    ["build", "--", ""],
    ["scaffold", ""],
    ["scaffold", "--", ""],
    ["mcp", ""],
  ]) {
    await assert.rejects(
      runWasiExecutable("/local/pannonico.wasm", invocation, options),
      /project root cannot be empty/,
    );
  }
  assert.deepEqual(calls, []);
});

test("distinguishes omitted, bare-separator, and literal whitespace roots", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const whitespace = join(root, "   ");
  mkdirSync(whitespace);
  try {
    for (const command of ["build", "scaffold"]) {
      for (const suffix of [[], ["--"]]) {
        const invocation = await prepareWasiInvocation([command, ...suffix], { cwd: root });
        assert.deepEqual(invocation.preopens, { "/project": root });
        assert.deepEqual(invocation.args, [command, "/project"]);
      }
      const literal = await prepareWasiInvocation([command, "   "], { cwd: root });
      assert.deepEqual(literal.preopens, { "/project": whitespace });
      assert.deepEqual(literal.args, [command, "/project"]);
    }
    const mcp = await prepareWasiInvocation(["mcp", "   "], { cwd: root });
    assert.deepEqual(mcp, {
      args: ["mcp", "/project"],
      env: {},
      preopens: { "/project": whitespace },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps genuine project help forms filesystem-free", async () => {
  for (const command of ["build", "scaffold"]) {
    for (const flag of ["--help", "--help=true", "-h"]) {
      const args = [command, flag];
      const invocation = await prepareWasiInvocation(args, {
        environment: { SOURCE_DATE_EPOCH: "123", SECRET: "hidden" },
        lstat: async () => assert.fail("help must not inspect a project root"),
        realpath: async () => assert.fail("help must not inspect a project root"),
        stat: async () => assert.fail("help must not inspect a project root"),
      });
      assert.deepEqual(invocation, {
        args,
        env: { SOURCE_DATE_EPOCH: "123" },
        preopens: {},
      });
    }
  }
});

test("confines help-looking option values and separator roots", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-wasi-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    for (const [optionArguments, forwarded] of [
      [
        ["--jobs", "--help"],
        ["--jobs", "--help"],
      ],
      [
        ["--max-output-workers", "--help=true"],
        ["--max-output-workers", "--help=true"],
      ],
      [
        ["--default-language", "-h"],
        ["--default-language", "-h"],
      ],
      [["--jobs=--help"], ["--jobs", "--help"]],
    ]) {
      const invocation = await prepareWasiInvocation(["build", ...optionArguments, project]);
      assert.deepEqual(invocation.args, ["build", ...forwarded, "/project"]);
      assert.deepEqual(invocation.preopens, { "/project": project });
    }

    for (const [command, name] of [
      ["build", "--help"],
      ["build", "--help=true"],
      ["scaffold", "-h"],
    ]) {
      const selected = join(root, name);
      mkdirSync(selected);
      const invocation = await prepareWasiInvocation([command, "--", name], { cwd: root });
      assert.deepEqual(invocation.args, [command, "/project"]);
      assert.deepEqual(invocation.preopens, { "/project": selected });
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("keeps exact MCP help forms filesystem-free", async () => {
  for (const flag of ["--help", "-h"]) {
    const invocation = await prepareWasiInvocation(["mcp", flag], {
      environment: { SOURCE_DATE_EPOCH: "123", SECRET: "hidden" },
    });
    assert.deepEqual(invocation, { args: ["mcp", flag], env: {}, preopens: {} });
  }
});

test("maps MCP cwd or one explicit directory to the fixed guest project", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-mcp-"));
  const project = join(root, "site");
  mkdirSync(project);
  try {
    const implicit = await prepareWasiInvocation(["mcp"], {
      cwd: project,
      environment: { SOURCE_DATE_EPOCH: "123", SECRET: "hidden" },
    });
    assert.deepEqual(implicit, {
      args: ["mcp", "/project"],
      env: {},
      preopens: { "/project": project },
    });
    const explicit = await prepareWasiInvocation(["mcp", project], {
      cwd: root,
      environment: {},
    });
    assert.deepEqual(explicit, {
      args: ["mcp", "/project"],
      env: {},
      preopens: { "/project": project },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects invalid MCP roots and syntax before module compilation", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-mcp-"));
  const project = join(root, "site");
  const file = join(root, "article.md");
  mkdirSync(project);
  writeFileSync(file, "# Article\n");
  try {
    await assert.rejects(
      prepareWasiInvocation(["mcp", "--unknown"], { cwd: project }),
      /unknown mcp option/,
    );
    await assert.rejects(
      prepareWasiInvocation(["mcp", project, root], { cwd: project }),
      /at most one project root/,
    );
    await assert.rejects(prepareWasiInvocation(["mcp", file]), /not a directory/);
    await assert.rejects(prepareWasiInvocation(["mcp", join(root, "missing")]), /ENOENT/);
    await assert.rejects(prepareWasiInvocation(["mcp", resolve("/")]), /filesystem root/);
    if (process.platform !== "win32") {
      const link = join(root, "site-link");
      symlinkSync(project, link);
      await assert.rejects(prepareWasiInvocation(["mcp", link]), /contains a symlink/);
    }

    let read = false;
    await assert.rejects(
      runWasiExecutable("/local/pannonico.wasm", ["mcp", file], {
        readModule: async () => {
          read = true;
          return Buffer.from("module");
        },
      }),
      /not a directory/,
    );
    assert.equal(read, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("hosts MCP with only project preopen, inherited protocol streams, and no environment", async () => {
  const root = mkdtempSync(join(TEST_TEMP_ROOT, "pannonico-node-mcp-"));
  let configuration;
  class FakeMcpWasi {
    /** constructor captures the complete preview1 grant before the long-lived server starts. */
    constructor(value) {
      configuration = value;
      this.wasiImport = { mcp: true };
    }

    /** start models a clean long-lived MCP server shutdown after protocol handling. */
    start() {
      return 0;
    }
  }
  try {
    const status = await runWasiExecutable("/local/pannonico.wasm", ["mcp", root], {
      environment: { SOURCE_DATE_EPOCH: "123", SECRET: "hidden" },
      stdin: { fd: 20 },
      stdout: { fd: 21 },
      stderr: { fd: 22 },
      Wasi: FakeMcpWasi,
      readModule: async () => Buffer.from("module"),
      compile: async () => ({ compiled: true }),
      instantiate: async () => ({ module: true }),
    });
    assert.equal(status, 0);
    assert.deepEqual(configuration, {
      version: "preview1",
      args: ["pannonico", "mcp", "/project"],
      env: {},
      preopens: { "/project": root },
      stdin: 20,
      stdout: 21,
      stderr: 22,
      returnOnExit: true,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runs preview1 with inherited stream descriptors and exact guest status", async () => {
  let configuration;
  let imports;
  class FakeWasi {
    /** constructor captures the ordinary preview1 configuration for stream assertions. */
    constructor(value) {
      configuration = value;
      this.wasiImport = { test: true };
    }
    /** start returns a deterministic guest status after checking the instantiated module. */
    start(instance) {
      assert.deepEqual(instance, { module: true });
      return 31;
    }
  }
  const status = await runWasiExecutable("/local/pannonico.wasm", ["--version"], {
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
