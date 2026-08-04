---
name: Synchronized Free launcher release
about: Track binary-driven publication of the public Pannonico launcher
title: "release: prepare Free launcher vX.Y.Z"
labels: RELEASE
assignees: vsjov
---

# Free launcher release vX.Y.Z

The matching `pannonico-go` and `pannonico-binaries` tags are authoritative. Do
not choose or publish a launcher version independently.

## Candidate

- [ ] Confirm all six native packages and the WASI package exist at `X.Y.Z`.
- [ ] Confirm the binary repository contains tag `vX.Y.Z`.

```sh
VERSION=X.Y.Z
git ls-remote --exit-code --tags \
  https://github.com/vx-rs/pannonico-binaries.git "refs/tags/v$VERSION"
for package_name in \
  @vx.rs/pannonico-bin-linux-x64 \
  @vx.rs/pannonico-bin-linux-arm64 \
  @vx.rs/pannonico-bin-darwin-x64 \
  @vx.rs/pannonico-bin-darwin-arm64 \
  @vx.rs/pannonico-bin-win32-x64 \
  @vx.rs/pannonico-bin-win32-arm64 \
  @vx.rs/pannonico-wasi; do
  npm view "$package_name@$VERSION" version --registry=https://registry.npmjs.org
done
```

- [ ] Run the complete repository gate.
- [ ] Build and test the local eight-package set when diagnosing the launcher
      boundary.

```sh
VERSION=X.Y.Z
npm ci --ignore-scripts
npm run format:check
npm run lint
npm test
npm run pack:check
npm run package:local -- \
  --version "$VERSION" \
  --binaries ../pannonico-binaries \
  --output "../pannonico-go/dist/free/v$VERSION/npm"
npm run test:consumer -- \
  --version "$VERSION" \
  --packages "../pannonico-go/dist/free/v$VERSION/npm"
```

- [ ] If automatic dispatch failed before wrapper publication, run the manual
      recovery dispatch.

```sh
VERSION=X.Y.Z
gh workflow run release.yml \
  --repo vx-rs/pannonico-node --ref master \
  -f version="$VERSION" \
  -f binary_repository_tag="v$VERSION"
```

## Completion

- [ ] Confirm CI tagged the synchronized launcher at `vX.Y.Z`.
- [ ] Confirm `@vx.rs/pannonico@X.Y.Z` published with provenance.
- [ ] Run the exact registry-backed consumer.

```sh
VERSION=X.Y.Z
git ls-remote --exit-code --tags origin "refs/tags/v$VERSION"
npm view "@vx.rs/pannonico@$VERSION" version \
  --registry=https://registry.npmjs.org
node scripts/test-registry-consumer.ts \
  --version "$VERSION" --package "@vx.rs/pannonico@$VERSION"
```

Never reuse `X.Y.Z` after the launcher has been published.
