# Public npm release

The private `pannonico-go` release remains the source and build authority. A
matching committed `pannonico-binaries` import owns the six native packages and
the WASI package. This repository owns only the exact-version public launcher.

## Local package set

After the binary repository has imported and validated one matching version,
create all eight tarballs without changing a committed package manifest:

```sh
npm run package:local -- \
  --version X.Y.Z \
  --binaries ../pannonico-binaries \
  --output ../pannonico-go/dist/free/vX.Y.Z/npm

npm run test:consumer -- \
  --version X.Y.Z \
  --packages ../pannonico-go/dist/free/vX.Y.Z/npm
```

The packager reruns the binary repository's independent validator, stages all
output, and creates the exact wrapper, six native, and WASI filenames. The
consumer test installs only those tarballs with lifecycle scripts disabled and
npm offline, then executes host-native, missing-native fallback, and
forced-WASI version, help, scaffold, and build behavior.

Run the repository gate independently with:

```sh
npm ci --ignore-scripts
npm run format:check
npm run lint
npm test
npm run pack:check
```

## Publication order

1. Complete every private source and public binary verification gate.
2. Create the reviewed `pannonico-binaries` tag and hosted public release.
3. Publish all seven exact target packages with npm trusted publishing.
4. The binary workflow dispatches this repository with the same version and
   binary tag. Manual dispatch remains available for recovery before wrapper
   publication.
5. The workflow verifies package availability, tests registry-backed native
   and forced-WASI consumers, commits and tags only the synchronized wrapper
   metadata, and publishes `@vx.rs/pannonico` with provenance.
6. The final job waits for npm propagation and verifies
   `@vx.rs/pannonico@X.Y.Z` in a new registry-only project.

If automatic dispatch fails before the wrapper is published, run the manual
recovery dispatch:

```sh
VERSION=X.Y.Z
gh workflow run release.yml \
  --repo vx-rs/pannonico-node --ref master \
  -f version="$VERSION" \
  -f binary_repository_tag="v$VERSION"
```

Verify the exact published wrapper with:

```sh
VERSION=X.Y.Z
npm view "@vx.rs/pannonico@$VERSION" version \
  --registry=https://registry.npmjs.org
node scripts/test-registry-consumer.ts \
  --version "$VERSION" --package "@vx.rs/pannonico@$VERSION"
```

Do not retry a partially published immutable version. Diagnose the failed gate
and release a new patch or prerelease version.

Trusted-publisher setup is documented in
[`TRUSTED-PUBLISHING.md`](./TRUSTED-PUBLISHING.md).
