import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { testRegistryConsumers } from "../scripts/test-registry-consumer.ts";

test("checks native, missing-native, and forced-WASI registry-backed wrapper consumers", () => {
  const root = mkdtempSync(join(os.tmpdir(), "pannonico-registry-test-"));
  const wrapper = join(root, "pannonico-1.2.3.tgz");
  writeFileSync(wrapper, "fixture");
  const invocations = [];
  try {
    testRegistryConsumers("1.2.3", wrapper, (command, args, options) => {
      invocations.push({ command, args, environment: options.env });
      return {
        status: 0,
        stdout: args.at(-1) === "--version" ? "pannonico 1.2.3\n" : "",
        stderr: "",
      };
    });
    assert.equal(invocations.filter(({ command }) => command === "npm").length, 3);
    assert.equal(
      invocations.some(
        ({ command, args }) => command === "npm" && args.includes("--omit=optional"),
      ),
      true,
    );
    assert.equal(
      invocations.some(
        ({ args, environment }) =>
          args.at(-1) === "--version" && environment.PANNONICO_FORCE_WASI === "1",
      ),
      true,
    );
    assert.equal(
      invocations.some(
        ({ args, environment }) =>
          args.at(-1) === "--version" && environment.PANNONICO_FORCE_WASI === undefined,
      ),
      true,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
