# Compilation and release

The sibling Go repository owns executable compilation and the artifact
manifest producer. `make copy-free-node` or `make copy-pro-node` builds a
matched native/WASI pair, stages both members, checks their product metadata,
hashes the staged bytes, and renames `artifacts/manifest.json` last.

This repository has no Makefile. Run the producer wrapper from the Go
repository, then use the npm verifier here:

```text
cd ../pannonico-go
make copy-pro-node VERSION=0.0.0-dev SOURCE_REVISION=development
cd ../pannonico-node
npm run package:check
```

The Make target already runs `npm run package:check`; the final command is
useful when rechecking an unchanged local artifact pair.

The launcher requires the manifest and both bound member paths. Runtime
selection checks the selected member. Package verification checks both members
and requires the package payload to contain exactly the manifest paths plus the
files declared by `package.json`.

Use `SOURCE_REVISION=development` for an explicitly local build. Use a full
lowercase 40-character Git revision for a clean revision-bound pair.

There is no `prepare` script, generated package graph, registry publication, or
install-time artifact download. A private Git snapshot must deliberately commit
the ignored manifest and members when another machine needs them.

See the Go
[compilation and release index](https://github.com/vx-rs/pannonico-go/blob/master/documentation/maintainers/compilation-and-release/README.md)
for producer commands.
