# Installation and updates

This private prototype supports local linking and immutable private Git
snapshots. It has no registry release, install-time downloader, or automatic
updater.

For local development, a maintainer first creates a matched artifact pair from
the sibling Go repository:

```text
cd ../pannonico-go
make copy-free-node VERSION=0.0.0-dev SOURCE_REVISION=development
```

Use `make copy-pro-node` for Pro. Then install and link the launcher:

```text
cd ../pannonico-node
npm ci --ignore-scripts
npm test
npm link
```

In a consumer project, run `npm link @vx.rs/pannonico`. Remove the link with
`npm unlink @vx.rs/pannonico` when the local test is complete.

For a private Git dependency, pin a commit that deliberately contains the
ignored artifact manifest and both artifact members. The package does not
create or download those members during installation.

After producing a matched pair, create the snapshot deliberately:

```text
git add -f artifacts/manifest.json artifacts/native/pannonico artifacts/pannonico.wasm
git commit -m "chore: snapshot local Pannonico artifacts"
git rev-parse HEAD
```

Use `artifacts/native/pannonico.exe` for a Windows-native snapshot. Pin the
commit printed after the artifact commit, not the preceding source-only
revision.

Maintainers should read the
[artifact contract](../../maintainers/compilation-and-release/README.md).
