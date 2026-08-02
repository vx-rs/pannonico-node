# Pannonico

`@vx.rs/pannonico` is the verified Node.js launcher for the Pannonico static
site generator. It selects an exact-version native package for Linux, macOS,
or Windows and uses the regular `@vx.rs/pannonico-wasi` dependency when the
native package is unavailable or the host tuple is unsupported.

## Requirements and installation

Pannonico requires Node.js 24 or newer.

```sh
npm install --save-dev @vx.rs/pannonico
npx pannonico scaffold site
npx pannonico build site
```

The package has no third-party runtime dependencies, install scripts, or
runtime downloads. It verifies the selected package identity, exact version,
target metadata, and SHA-256 checksum immediately before execution.

## WASI fallback

Set `PANNONICO_FORCE_WASI=1` to select the portable WASI runtime explicitly:

```sh
PANNONICO_FORCE_WASI=1 npx pannonico build site
```

The WASI host preopens only the selected project at `/project`, forwards only
`SOURCE_DATE_EPOCH`, and preserves standard streams and exit status. Absolute
path options must remain inside the selected project. Native-only commands are
reported by Pannonico with exit status `4`.

An installed native package with invalid metadata, a version mismatch, or a
checksum mismatch is a security failure and never causes an implicit WASI
fallback. If the operating system blocks a verified native executable, the
launcher reports how to retry explicitly with `PANNONICO_FORCE_WASI=1`.

## Launcher diagnostics

`PANNONICO_LAUNCHER_DEBUG=1` writes launcher version, host tuple, selected
package, verification completion, fallback reason, and execution mode to
standard error. Normal operation emits no launcher diagnostics. Debug output
does not include absolute package paths, checksum values, or environment
contents.

Release construction and publication are described in
[`docs/RELEASE.md`](./docs/RELEASE.md).
