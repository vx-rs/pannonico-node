# Pannonico local launcher

`@vx.rs/pannonico` is the private native/WASI launcher for locally built
Pannonico artifacts. It validates one generated manifest and the selected
member before execution. It does not download artifacts, publish packages, or
resolve platform packages during installation.

## Install for local development

Create and validate a matched artifact pair from the sibling Go repository:

```text
cd ../pannonico-go
make copy-free-node VERSION=0.0.0-dev SOURCE_REVISION=development
```

Use `make copy-pro-node` for Pro. Do not copy artifact members manually; the
launcher requires the generated `artifacts/manifest.json`, verified member
metadata, and SHA-256 digests.

Then install, test, and link the package:

```text
cd ../pannonico-node
npm ci --ignore-scripts
npm test
npm link
```

Link it into a local consumer with `npm link @vx.rs/pannonico`. Remove the link
with `npm unlink @vx.rs/pannonico` when the test is complete.

## Runtime selection

The launcher runs the native member when it matches the current host. Set
`PANNONICO_FORCE_WASI=1` to select the portable member explicitly:

```text
PANNONICO_FORCE_WASI=1 npx pannonico build site
```

Automatic WASI fallback occurs only when the native member is missing or the
host platform and architecture are unsupported. The launcher verifies the WASI
member first and writes one reason to standard error. Manifest errors, unsafe
paths, symlinks, non-files, checksum or target mismatches, native start
failures, and a missing selected WASI member are hard errors.

The WASI host preopens one validated project as `/project`, forwards only
`SOURCE_DATE_EPOCH`, and preserves standard streams and exit status. Read the
[WASI runtime guide](https://github.com/vx-rs/pannonico-node/blob/master/documentation/user-manual/wasi/README.md)
for file and command boundaries.

## MCP through WASI

The built-in MCP server can run through the portable artifact:

```text
PANNONICO_FORCE_WASI=1 npx pannonico mcp
PANNONICO_FORCE_WASI=1 npx pannonico mcp ./site
```

The launcher preopens one real, non-root, non-symlink project directory and
passes it to the guest as `/project`. See the
[MCP through WASI guide](https://github.com/vx-rs/pannonico-node/blob/master/documentation/user-manual/mcp/README.md).

## Private Git dependency

A consumer may pin this repository during the prototype phase:

```json
{
  "devDependencies": {
    "@vx.rs/pannonico": "git+ssh://git@github.com/vx-rs/pannonico-node.git#<commit>"
  }
}
```

Git dependencies are immutable snapshots. Commit the ignored manifest and both
members deliberately when another machine or CI job needs them. The package has
no `prepare` script or install-time artifact download.

## Documentation

- [Documentation table of contents](https://github.com/vx-rs/pannonico-node/blob/master/documentation/README.md)
- [Installation and updates](https://github.com/vx-rs/pannonico-node/blob/master/documentation/user-manual/installation-and-updates/README.md)
- [Maintainer workflow](https://github.com/vx-rs/pannonico-node/blob/master/documentation/maintainers/workflow/README.md)
- [Testing](https://github.com/vx-rs/pannonico-node/blob/master/documentation/maintainers/testing/README.md)
- [Artifact and package contract](https://github.com/vx-rs/pannonico-node/blob/master/documentation/maintainers/compilation-and-release/README.md)
- [Internal Vite integration fixture](https://github.com/vx-rs/pannonico-node/blob/master/demo/README.md)

The Go repository contains the canonical
[Pannonico user manual](https://github.com/vx-rs/pannonico-go/blob/master/documentation/user-manual/README.md).
