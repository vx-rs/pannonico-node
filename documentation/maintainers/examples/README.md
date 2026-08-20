# Integration fixture

The [internal Vite demo](../../../demo/README.md) is a complete launcher consumer
and product-integration fixture. It is not the minimum site tutorial.

The fixture owns its Vite, Sass, Lightning CSS, and TypeScript dependencies. It
tests a managed native build, an external-manifest WASI build, Rich Markdown,
CSS inlining, emitted assets, sitemap output, and native/WASI output parity.

Run demo tasks from the repository root through the root workspace wrappers:

| npm command              | Workspace command                                        | Effect                                                                     |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `npm run demo:typecheck` | `npm run typecheck --workspace @vx.rs/pannonico-demo`    | Runs `tsc --noEmit`; no Pannonico artifact is required.                    |
| `npm run demo:assets`    | `npm run assets:build --workspace @vx.rs/pannonico-demo` | Runs the demo's `node run-vite.mjs build`.                                 |
| `npm run demo:build`     | `node bin/pannonico.js build --beautify demo`            | Runs a managed native demo build through the launcher.                     |
| `npm run demo:watch`     | `npm run watch --workspace @vx.rs/pannonico-demo`        | Runs `pannonico watch --beautify .` inside the demo workspace.             |
| `npm run demo:verify`    | `node scripts/verify-demo.mjs`                           | Verifies matched Pro native/WASI output and the complete fixture contract. |

For the normal non-watch verification sequence:

```text
npm run demo:typecheck && npm run demo:assets && npm run demo:build && npm run demo:verify
```

Inside `demo/`, `npm run build` and `npm run watch` call the workspace-linked
`pannonico` executable directly. `npm run assets:dev` starts the demo's Vite
development command without starting Pannonico.

Use the Go [Vite example](https://github.com/vx-rs/pannonico-go/blob/master/examples/vite-site/README.md)
for a smaller authoring example.
