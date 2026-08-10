# Internal Vite connector demo

This private npm workspace is the smallest complete consumer example for the
Pannonico Vite connector. It keeps Vite, Sass, and TypeScript outside the
launcher package while using the launcher's ignored local artifacts.

From the repository root, install the single workspace lockfile and run the
artifact-independent frontend checks:

```sh
npm ci --ignore-scripts
npm run demo:typecheck
npm run demo:assets
```

After copying a matched native and WASI artifact pair into the root
`artifacts/` directory, build or verify the complete site:

```sh
npm run demo:build
npm run demo:verify
```

To inspect the portable path separately, build the assets first because WASI
does not start host processes, then force the launcher fallback:

```sh
npm run demo:assets
PANNONICO_FORCE_WASI=1 npm run demo:build
```

The equivalent command from this directory is `npm run build`. A Pro native
artifact can coordinate Pannonico and Vite development with `npm run watch`
here or `npm run demo:watch` at the root. Free native and WASI artifacts do not
provide watch mode.

`src/app.ts` imports `src/app.scss`. Vite writes a hashed bundle, compiled CSS,
and `.pannonico/vite/.vite/manifest.json`. Pannonico maps the manifest's
`src/app.ts` entry to the `app` alias used by `partials/vite.html`, then renders
the HTML and Markdown pages through `layouts/default.html`.

Generated Vite state and `dist*` site output are ignored. Do not commit them or
add a second lockfile under this workspace.
