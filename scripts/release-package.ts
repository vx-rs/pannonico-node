import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_TARGETS, WASI_TARGET } from "../lib/targets.js";

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** validateVersion accepts the release version subset shared with the Go artifact builder. */
export const validateVersion = (version) => {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)}`);
  }
  return version;
};

/** releasePackageManifest synchronizes the launcher and its exact public package graph. */
export const releasePackageManifest = (source, version) => {
  validateVersion(version);
  if (source.name !== "@vx.rs/pannonico") {
    throw new Error("Launcher manifest has an unexpected package name");
  }
  const {
    private: _private,
    dependencies: _dependencies,
    optionalDependencies: _optionalDependencies,
    ...publishable
  } = source;
  return {
    ...publishable,
    version,
    dependencies: { [WASI_TARGET.packageName]: version },
    optionalDependencies: Object.fromEntries(
      NATIVE_TARGETS.map(({ packageName }) => [packageName, version]),
    ),
  };
};

/** updateReleaseFiles updates one checkout immediately before an approved release workflow. */
export const updateReleaseFiles = (root, version) => {
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const manifest = releasePackageManifest(JSON.parse(readFileSync(packagePath, "utf8")), version);
  writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.name = manifest.name;
  lock.version = version;
  if (!lock.packages?.[""]) throw new Error("Package lock has no root package metadata");
  lock.packages[""].name = manifest.name;
  lock.packages[""].version = version;
  delete lock.packages[""].private;
  lock.packages[""].dependencies = manifest.dependencies;
  lock.packages[""].optionalDependencies = manifest.optionalDependencies;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
};
