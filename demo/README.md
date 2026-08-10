# Internal Vite connector demo

This private npm workspace is the smallest complete consumer example for the
Pannonico Vite connector. It keeps Vite, Sass, Lightning CSS, and TypeScript
outside the launcher package while using the launcher's ignored local
artifacts.

From the repository root, install the single workspace lockfile and run the
artifact-independent frontend checks:

```sh
npm ci --ignore-scripts
npm run demo:typecheck
npm run demo:assets
```

After copying a matched Pro native and Pro WASI artifact pair into the root
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

The equivalent command from this directory is `npm run build`. Both it and
`npm run watch` pass the Pro-only `--beautify` flag, so generated HTML and
Markdown pages use stable two-space nesting after template/Vite integration and
before validation. A Pro native artifact can coordinate Pannonico and Vite
development with `npm run watch` here or `npm run demo:watch` at the root.

The project also enables the Pro-only `css.inline` setting. The shared partial
marks only production CSS links with `data-pannonico-inline-css`; development
links remain unmarked so Vite CSS HMR continues to work. Copy a matched Pro
native/WASI pair. `demo:verify` checks `css-inlining` on both artifacts before
starting either build.

The verifier uses `--beautify` for native and forced-WASI builds, requires their
complete output trees to be byte-identical, and checks readable nesting, LF
line endings, and the no-final-newline contract on both pages. It also requires
generated element styles, residual media CSS, no production marker or selected
CSS link, a rebased root-relative SVG URL, the retained module script, and the
published CSS, JavaScript, and SVG files.

`src/app.ts` imports `src/app.scss`. Sass compiles its readable nested source;
Vite delegates the configured CSS transform and production minification to
Lightning CSS. `base: "./"` and `assetsInlineLimit: 0` keep the referenced
`accent-grid.svg` as a separate artifact and leave a relative URL in compiled
CSS. Pannonico resolves that URL against the hashed stylesheet before moving
matched declarations into HTML.

Vite writes a hashed bundle, compiled CSS, SVG, and
`.pannonico/vite/.vite/manifest.json`. Pannonico maps the manifest's
`src/app.ts` entry to the `app` alias used by `partials/vite.html`, then renders
the HTML and Markdown pages through `layouts/default.html`. The compiled CSS
and SVG remain published even though the selected production link is consumed.

Generated Vite state and `dist*` site output are ignored. Do not commit them or
add a second lockfile under this workspace.
