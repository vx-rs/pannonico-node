# Testing

Use these checks in increasing order of required local state:

1. `npm test` runs launcher, artifact, WASI-host, and package tests with
   disposable fixtures.
2. `npm run package:test` runs the source-only package dry-run contract.
3. `npm run package:check` validates the current local manifest, both selected
   members, and the package dry-run payload. It requires a matched artifact
   pair created by the Go producer.
4. `npm run demo:typecheck` and `npm run demo:assets` validate frontend source
   without Pannonico artifacts.
5. `npm run demo:verify` requires matched Pro native and WASI artifacts and
   validates native/WASI site parity and the demo output contract.

Formatting and linting are separate gates:

```text
npm run format:check
npm run lint
```

## Package-script reference

| npm command             | Underlying command                                             | Effect and prerequisites                                                                                        |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm test`              | `node --test test/*.test.ts`                                   | Runs all four source test files with disposable fixtures.                                                       |
| `npm run test:coverage` | The same Node test command with `--experimental-test-coverage` | Runs the full suite and prints coverage.                                                                        |
| `npm run package:test`  | `node --test test/package.test.ts`                             | Runs only the source/package dry-run contract. It does not require real artifacts.                              |
| `npm run package:check` | `node scripts/verify-package.mjs`                              | Validates the current manifest, both artifact members, and the npm payload. It requires a matched pair from Go. |

`npm test` is the convenient wrapper for the individual test files. Run one
file directly while diagnosing it:

```text
node --test test/wasi-host.test.ts
```

The [package scripts README](../../../scripts/README.md) documents the script-local
package verifier boundary.
