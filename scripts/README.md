# Package scripts

The [maintainer testing guide](../documentation/maintainers/testing/README.md)
orders the repository checks. The
[artifact and package contract](../documentation/maintainers/compilation-and-release/README.md)
is the canonical cross-repository procedure.

`verify-package.mjs` validates the private launcher's current
`artifacts/manifest.json`, native member, and WASI member. It then runs
`npm pack --dry-run --json` with a disposable cache and checks the payload. The
reported `artifacts/` paths must be exactly the manifest and both paths named by
it. A missing, duplicate, stale, or otherwise unbound artifact fails
verification. Other package files remain governed by `package.json`, while
dependency, coverage, build, cache, staging, and demo output must remain absent.

The sibling Go repository calls this script through `npm run package:check`
after `make copy-free-node` or `make copy-pro-node` commits a fresh pair. Run it
directly only after generating the pair:

```text
npm run package:check
```

The command does not build artifacts, change package metadata, create a
tarball, or publish the package. `test/package.test.ts` exercises the same dry
run against a deterministic pair in a disposable package tree, so source-only
CI never reads or replaces ignored developer artifacts.

Before the launcher constructs WASI, its host parser assigns each supported
argument a help, option-value, separator, or project-root role. Genuine project
help requires no project filesystem access. Help-looking option values and
roots after `--` still receive the single `/project` preopen. An omitted root or
bare separator selects the working directory; an explicit empty root fails
before path inspection, project creation, module loading, or compilation. MCP
keeps only its exact sole-argument `--help` and `-h` forms filesystem-free.
