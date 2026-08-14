// Imports
// -----------------------------------------------------------------------------

// Node.js
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Internal
import { verifyPackageArtifacts } from "../lib/artifacts.js";

// Constants
// -----------------------------------------------------------------------------

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_NPM_OUTPUT_BYTES = 4 * 1024 * 1024;

// Package verification
// -----------------------------------------------------------------------------

/**
 * runNpmPack performs a dry run with a task-local cache and returns the declared payload paths.
 *
 * npm may otherwise populate a user cache outside the repository. Using npm's active CLI module
 * when available also keeps the command cross-platform without introducing shell interpretation.
 * stdout is a task-local regular file because npm 11 can exit successfully without flushing JSON
 * to a child-process pipe; the file is read only after the exact child status has been accepted.
 *
 * @param {string} packageRoot Package root to inspect.
 * @param {string} cacheRoot Disposable npm cache directory.
 * @returns {Promise<string[]>} Sorted paths reported for the tarball payload.
 */
const runNpmPack = async (packageRoot, cacheRoot) => {
  const npmCLI = process.env.npm_execpath;
  const executable = npmCLI ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const prefix = npmCLI ? [npmCLI] : [];
  // Node's test runner marker would make npm's Node process join the parent test protocol instead
  // of behaving as an ordinary CLI. An outer npm lifecycle may also set loglevel=silent, which
  // suppresses npm pack's JSON despite a successful status. Remove both inherited controls and set
  // the child log level explicitly so successful verification always has a payload to inspect.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "NODE_TEST_CONTEXT" &&
        !new Set(["npm_config_loglevel", "npm_config_silent"]).has(name.toLowerCase()),
    ),
  );
  const outputPath = path.join(cacheRoot, "pack-report.json");
  const output = await open(outputPath, "w");
  let diagnostic = "";
  try {
    diagnostic = await new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          ...prefix,
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--loglevel=notice",
          "--cache",
          cacheRoot,
        ],
        {
          cwd: packageRoot,
          env: environment,
          stdio: ["ignore", output.fd, "pipe"],
          windowsHide: true,
        },
      );
      const chunks = [];
      let size = 0;
      child.stderr.on("data", (chunk) => {
        size += chunk.length;
        if (size <= MAX_NPM_OUTPUT_BYTES) chunks.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (status, signal) => {
        const stderr = Buffer.concat(chunks).toString("utf8");
        if (size > MAX_NPM_OUTPUT_BYTES) {
          reject(new Error("npm pack diagnostic exceeded the verification limit"));
        } else if (status !== 0) {
          reject(
            new Error(
              `npm pack failed with status ${status ?? `signal ${signal}`}: ${stderr.trim() || "no diagnostic"}`,
            ),
          );
        } else {
          resolve(stderr);
        }
      });
    });
  } finally {
    await output.close();
  }
  const bytes = await readFile(outputPath);
  if (bytes.length > MAX_NPM_OUTPUT_BYTES) {
    throw new Error("npm pack JSON exceeded the verification limit");
  }
  const stdout = bytes.toString("utf8");
  if (stdout.trim() === "") {
    throw new Error(`npm pack returned no JSON output: ${diagnostic.trim() || "no diagnostic"}`);
  }
  const report = JSON.parse(stdout);
  if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0].files)) {
    throw new Error("npm pack returned an unexpected JSON report");
  }
  return report[0].files.map((entry) => entry.path).sort();
};

/**
 * verifyPackageDryRun checks artifact bytes and the private npm payload's artifact closure.
 *
 * Go calls this after a fresh manifest-last pair commit. Both members must validate even when one
 * is not runnable on the current host. The npm-reported `artifacts/` files must be exactly the
 * manifest and its two bound member paths, with no missing, repeated, or stale alternate member.
 * Other package files remain package-owned, subject to the targeted output-tree exclusions here.
 *
 * @param {string} packageRoot Private launcher package root.
 * @returns {Promise<string[]>} Verified sorted dry-run payload paths.
 */
export const verifyPackageDryRun = async (packageRoot = PACKAGE_ROOT) => {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.private !== true || metadata.version !== "0.0.0") {
    throw new Error("launcher package must remain private at independent version 0.0.0");
  }
  const manifest = await verifyPackageArtifacts(path.join(packageRoot, "artifacts"));
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "pannonico-npm-cache-"));
  try {
    const files = await runNpmPack(packageRoot, cacheRoot);
    const required = [
      "artifacts/manifest.json",
      ...manifest.artifacts.map((artifact) => `artifacts/${artifact.path}`),
    ];
    const expectedArtifacts = new Set(required);
    const includedArtifacts = new Set();
    for (const file of files.filter((entry) => entry.startsWith("artifacts/"))) {
      if (!expectedArtifacts.has(file)) {
        throw new Error(`npm package includes unbound artifact ${file}`);
      }
      if (includedArtifacts.has(file)) {
        throw new Error(`npm package includes duplicate artifact ${file}`);
      }
      includedArtifacts.add(file);
    }
    for (const requiredPath of required) {
      if (!includedArtifacts.has(requiredPath))
        throw new Error(`npm package omits ${requiredPath}`);
    }
    const forbidden = files.find(
      (file) =>
        file === "node_modules" ||
        file.startsWith("node_modules/") ||
        file === "coverage" ||
        file.startsWith("coverage/") ||
        file.startsWith("build/") ||
        file.includes("/.cache/") ||
        file.includes(".pannonico-stage-") ||
        file.startsWith("demo/dist") ||
        file.startsWith("demo/.pannonico/"),
    );
    if (forbidden !== undefined)
      throw new Error(`npm package includes unrelated output ${forbidden}`);
    return files;
  } finally {
    await rm(cacheRoot, { force: true, recursive: true });
  }
};

/**
 * runCLI verifies the current package and prints a concise success summary for Make and CI logs.
 *
 * @returns {Promise<void>} Resolves after artifact and payload validation succeeds.
 */
const runCLI = async () => {
  const files = await verifyPackageDryRun();
  console.log(`Verified private Pannonico package payload (${files.length} files).`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCLI().catch((error) => {
    console.error(
      `Pannonico package verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
