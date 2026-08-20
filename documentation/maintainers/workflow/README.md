# Development workflow

Install the locked development dependencies without running package lifecycle
scripts:

```text
npm ci --ignore-scripts
```

Use the sibling Go repository to create a matched local artifact pair. Do not
copy members by hand; the producer validates both members and renames
`manifest.json` last.

Run source checks before artifact-dependent demo work:

```text
npm run format:check
npm run lint
npm test
npm run demo:typecheck
npm run demo:assets
```

The root package scripts wrap repository-local tools, so contributors do not
need to invoke binaries below `node_modules` directly:

| npm command            | Underlying command         | Effect                                      |
| ---------------------- | -------------------------- | ------------------------------------------- |
| `npm run format`       | `oxfmt --write .`          | Rewrites supported repository files.        |
| `npm run format:check` | `oxfmt --check .`          | Checks formatting without rewriting files.  |
| `npm run lint`         | `oxlint --deny-warnings .` | Lints the repository and fails on warnings. |
| `npm run lint:fix`     | `oxlint . --fix`           | Applies safe lint fixes where available.    |

Chain wrappers when later checks should run only after earlier checks pass:

```text
npm run format:check && npm run lint && npm test
```

Continue with [testing](../testing/README.md), the
[artifact contract](../compilation-and-release/README.md), or the
[integration fixture](../examples/README.md).
