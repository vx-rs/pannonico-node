# npm trusted publishing

Configure `@vx.rs/pannonico` with the following npm trusted publisher only
after the repository and initial package version exist:

- provider: GitHub Actions;
- organization: `vx-rs`;
- repository: `pannonico-node`;
- workflow filename: `release.yml`;
- environment: none;
- allowed action: publish.

The workflow uses a GitHub-hosted runner, Node 24, `id-token: write`, the public
npm registry, and `npm publish --provenance --access public`. After the trusted
publisher is connected, remove and revoke any temporary bootstrap token, then
require two-factor authentication and disallow token-based publication in npm
package settings.

The seven target packages require corresponding trusted publishers for the
`vx-rs/pannonico-binaries` `release.yml` workflow. Creating those connections,
bootstrapping a first package, changing credentials, and publishing are npm or
GitHub state changes; repository files cannot perform them locally.
