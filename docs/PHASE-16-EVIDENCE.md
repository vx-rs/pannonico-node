# Phase 16 evidence

## Scope

Phase 16 implements the public `@vx.rs/pannonico` launcher and its local npm
release path. The launcher contains no Pannonico source or generated site
content. It consumes the seven independently validated Free target packages
owned by `pannonico-binaries`.

The release manifest uses one exact regular dependency on
`@vx.rs/pannonico-wasi` and six exact optional native dependencies. The package
has no lifecycle script and no third-party runtime dependency. The committed
development manifest remains private and version `0.0.0`; release staging
creates the public versioned manifest without modifying the source checkout.

## Launcher contract

The launcher validates the selected package name, version, schema, edition,
target, payload, npm OS/CPU fields, file type, executable mode, canonical
checksum document, and payload digest immediately before execution. Installed
package corruption fails closed. WASI is selected only for an unsupported host
tuple, an omitted native optional dependency, or explicit
`PANNONICO_FORCE_WASI=1`.

Native execution inherits arguments, current directory, environment, standard
streams, exit status, and termination signal. The preview1 WASI host inherits
the three standard streams, exposes only `SOURCE_DATE_EPOCH`, and preopens at
most one resolved non-filesystem-root project at `/project`. Debug diagnostics
are opt-in and exclude absolute paths, environment contents, and checksum
values.

## Local release verification

A real seven-target Free `0.0.0-dev` distribution from source commit
`79346a736e9c6ef0cc2c10fb7681414bc592be69` passed the sanitized public import.
The Phase 16 Go `package-npm` command generated the exact seven target tarballs
and one wrapper tarball. A second build produced an identical eight-file
SHA-256 inventory.

The matching `test-npm` command installed every target package independently
and then exercised three clean consumers with npm offline and lifecycle scripts
disabled:

- the host-native package;
- a genuinely omitted native package with the WASI dependency present;
- explicit forced WASI.

Version, help, scaffold, and build behavior passed. The wrapper dry-run pack
report contained exactly the twelve allowed files, including its executable
launcher entrypoint and no target payload.

## Verification status

Formatting, warnings-denied lint, Node tests, package dry runs, lockfile
installation, dependency enumeration, npm audit, and Git whitespace checks
pass. Launcher coverage is 87.59 percent lines, 70.59 percent branches, and
92.68 percent functions. The binary-package owner reports 89.62 percent lines,
71.52 percent branches, and 96.59 percent functions.

The source repository's complete Free and Pro test configurations, vet,
documentation policy, and changed-package race tests pass. Both configurations
meet the 85.0 percent repository-wide statement coverage gate.

The configured release workflow performs an all-package unpublished preflight
before any trusted npm publish job and retains registry-backed native,
missing-native, and forced-WASI consumers as publication-time gates. Those
registry checks require immutable published packages and were not executed
locally. `actionlint` is unavailable in the local environment; workflow files
were formatted and manually reviewed.

No tag, push, hosted release, npm publication, registry write, credential
change, repository dispatch, or remote mutation occurred.
