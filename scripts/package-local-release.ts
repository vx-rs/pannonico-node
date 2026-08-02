import { spawnSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { NATIVE_TARGETS, WASI_TARGET } from "../lib/targets.js";
import { releasePackageManifest, validateVersion } from "./release-package.ts";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COPY_PATHS = ["bin", "lib", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"];

/** packageLocalRelease stages all seven payload packages and the synchronized launcher tarball. */
export const packageLocalRelease = (input, options = {}) => {
  const version = validateVersion(input.version);
  const binaries = resolve(input.binaries);
  const output = resolve(input.output);
  const repository = resolve(input.repository ?? REPOSITORY_ROOT);
  assertSafeOutput(output, repository, binaries);
  validateBinaryRelease(binaries, version, options.runCommand);
  const publicManifest = JSON.parse(readFileSync(join(binaries, "release-manifest.json"), "utf8"));
  if (
    publicManifest.schemaVersion !== 1 ||
    publicManifest.version !== version ||
    publicManifest.sourceTag !== `v${version}` ||
    !Array.isArray(publicManifest.targets) ||
    publicManifest.targets.length !== NATIVE_TARGETS.length + 1
  ) {
    throw new Error("Binary release manifest does not match the requested public Free version");
  }

  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".pannonico-package-stage-"));
  const wrapper = mkdtempSync(join(tmpdir(), "pannonico-wrapper-stage-"));
  const npmCache = join(wrapper, ".npm-cache");
  try {
    for (const contract of [...NATIVE_TARGETS, WASI_TARGET]) {
      const packageRoot = join(binaries, "packages", packageDirectory(contract));
      const report = pack(packageRoot, staging, npmCache, options.runCommand);
      validatePackReport(report, contract.packageName, version, [
        "COMMERCIAL-LICENSE.md",
        "LICENSE",
        "NOTICE",
        "README.md",
        "SHA256SUMS",
        contract.payload,
        "package.json",
      ]);
      renameSync(join(staging, report.filename), join(staging, tarballName(contract, version)));
    }
    for (const entry of COPY_PATHS) {
      copyRegularSource(join(repository, entry), join(wrapper, entry));
    }
    const sourceManifestPath = join(repository, "package.json");
    const sourceManifestInformation = lstatSync(sourceManifestPath);
    if (sourceManifestInformation.isSymbolicLink() || !sourceManifestInformation.isFile()) {
      throw new Error("Wrapper package.json is not a regular non-symlink file");
    }
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    writeFileSync(
      join(wrapper, "package.json"),
      `${JSON.stringify(releasePackageManifest(sourceManifest, version), null, 2)}\n`,
    );
    const wrapperReport = pack(wrapper, staging, npmCache, options.runCommand);
    validatePackReport(wrapperReport, "@vx.rs/pannonico", version, [
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
    ]);
    renameSync(join(staging, wrapperReport.filename), join(staging, `pannonico-${version}.tgz`));
    chmodSync(staging, 0o755);
    installStaged(staging, output);
    return expectedTarballs(version).map((name) => join(output, name));
  } finally {
    rmSync(wrapper, { force: true, recursive: true });
    if (existsSync(staging)) rmSync(staging, { force: true, recursive: true });
  }
};

/** expectedTarballs returns the exact local package-set filenames. */
export const expectedTarballs = (version) => [
  `pannonico-${version}.tgz`,
  ...NATIVE_TARGETS.map((contract) => tarballName(contract, version)),
  tarballName(WASI_TARGET, version),
];

const packageDirectory = (contract) =>
  contract.target === "wasi"
    ? "wasi"
    : contract.target.startsWith("windows-")
      ? contract.target.replace("windows-", "win32-")
      : contract.target;

const tarballName = (contract, version) =>
  `${contract.packageName.slice("@vx.rs/".length)}-${version}.tgz`;

const validateBinaryRelease = (root, version, runCommand = spawnSync) => {
  const result = runCommand(
    process.execPath,
    [join(root, "scripts", "validate-release.ts"), version],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Binary release validation failed: ${result.stderr || result.stdout}`);
  }
};

const pack = (root, destination, npmCache, runCommand = spawnSync) => {
  const result = runCommand(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, root],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  const reports = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (reports.length !== 1 || typeof reports[0].filename !== "string") {
    throw new Error("npm pack returned an unexpected report");
  }
  return reports[0];
};

const validatePackReport = (report, packageName, version, expectedFiles) => {
  if (
    report.name !== packageName ||
    report.version !== version ||
    report.filename !== basename(report.filename) ||
    !Array.isArray(report.files) ||
    report.entryCount !== expectedFiles.length
  ) {
    throw new Error(`npm pack metadata is invalid for ${packageName}`);
  }
  const actualFiles = report.files.map(({ path }) => path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error(`npm pack file list is invalid for ${packageName}`);
  }
};

const copyRegularSource = (source, destination) => {
  cpSync(source, destination, {
    recursive: true,
    filter: (candidate) => {
      const information = lstatSync(candidate);
      if (information.isSymbolicLink() || (!information.isDirectory() && !information.isFile())) {
        throw new Error(`Wrapper source is not a regular file or directory: ${candidate}`);
      }
      return true;
    },
  });
};

const assertSafeOutput = (output, repository, binaries) => {
  if (basename(output) !== "npm" || output === resolve("/") || output === resolve(tmpdir())) {
    throw new Error(`Refusing broad package output ${output}`);
  }
  for (const protectedRoot of [repository, binaries]) {
    const fromOutput = relative(output, protectedRoot);
    if (fromOutput === "" || (!fromOutput.startsWith("..") && !isAbsolute(fromOutput))) {
      throw new Error(`Package output would replace protected repository ${protectedRoot}`);
    }
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error(`Package output is a symlink: ${output}`);
  }
};

const installStaged = (staging, output) => {
  const backup = `${output}.previous`;
  if (existsSync(backup)) throw new Error(`Package output backup already exists: ${backup}`);
  const hadOutput = existsSync(output);
  if (hadOutput) renameSync(output, backup);
  try {
    renameSync(staging, output);
  } catch (error) {
    if (hadOutput) renameSync(backup, output);
    throw error;
  }
  if (hadOutput) rmSync(backup, { force: true, recursive: true });
};

const parseArguments = (arguments_) => {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--binaries", "--output", "--version"].includes(name) || !value) {
      throw new Error("Usage: package-local-release --version VERSION --binaries DIR --output DIR");
    }
    parsed[name.slice(2)] = value;
  }
  if (!parsed.version || !parsed.binaries || !parsed.output) {
    throw new Error("Usage: package-local-release --version VERSION --binaries DIR --output DIR");
  }
  return parsed;
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    const files = packageLocalRelease(parseArguments(process.argv.slice(2)));
    console.log(`Created ${files.length} local package tarballs`);
  } catch (error) {
    console.error(`Local packaging failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
