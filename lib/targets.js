const nativeTargets = [
  ["linux-x64", "linux", "x64", "@vx.rs/pannonico-bin-linux-x64", "bin/pannonico"],
  ["linux-arm64", "linux", "arm64", "@vx.rs/pannonico-bin-linux-arm64", "bin/pannonico"],
  ["darwin-x64", "darwin", "x64", "@vx.rs/pannonico-bin-darwin-x64", "bin/pannonico"],
  ["darwin-arm64", "darwin", "arm64", "@vx.rs/pannonico-bin-darwin-arm64", "bin/pannonico"],
  ["windows-x64", "win32", "x64", "@vx.rs/pannonico-bin-win32-x64", "bin/pannonico.exe"],
  ["windows-arm64", "win32", "arm64", "@vx.rs/pannonico-bin-win32-arm64", "bin/pannonico.exe"],
];

/** NATIVE_TARGETS is the immutable public native package contract. */
export const NATIVE_TARGETS = Object.freeze(
  nativeTargets.map(([target, platform, architecture, packageName, payload]) =>
    Object.freeze({ architecture, packageName, payload, platform, target }),
  ),
);

/** WASI_TARGET is the immutable portable fallback package contract. */
export const WASI_TARGET = Object.freeze({
  packageName: "@vx.rs/pannonico-wasi",
  payload: "pannonico.wasm",
  target: "wasi",
});

/** selectNativeTarget returns the package contract for one Node host tuple. */
export const selectNativeTarget = (platform, architecture) =>
  NATIVE_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture,
  );
