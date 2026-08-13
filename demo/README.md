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

CSS inlining has no project setting or command-line flag. Each page supplies
ordinary `inlineCSS` frontmatter used only by the shared demo partial. In
production, `inlined.html` adds `data-pannonico-inline-css` to the Vite CSS
link, while `index.html` and `guide.html` leave the same link unmarked.
Development links are always unmarked so Vite CSS HMR continues to work. Copy
a matched Pro native/WASI pair; `demo:verify` checks `css-inlining` and
`rich-markdown` on both
artifacts before starting either build.

`pages/guide.md` exercises all nine rich-Markdown plugins. Verification requires
the native and forced-WASI outputs to contain the same heading anchor,
footnotes, abbreviation, container, subscript, superscript, mark, insertion,
and deletion HTML. The demo SCSS customizes `pannonico-container` and its
`pannonico-container--build-note` modifier; Pannonico intentionally provides no
default container theme. The guide is excluded from Oxfmt because its generic
Markdown formatter rewrites the single-tilde subscript example as double-tilde
deletion syntax.

The verifier uses `--beautify` for native and forced-WASI builds, requires their
complete output trees to be byte-identical, and checks readable nesting, LF
line endings, and the no-final-newline contract on all three pages. It requires
the guide's single footnote group to remain in `.pannonico.content` after the
page's closing `main` and before the layout footer. It requires
`inlined.html` to contain generated element styles, residual media CSS, and a
rebased root-relative SVG URL without the selected link. It separately requires
`index.html` and `guide.html` to retain the compiled stylesheet link without
generated inline CSS. Every page keeps the module script, and the compiled CSS,
JavaScript, and SVG files remain published.

`src/app.ts` imports `src/app.scss`. Sass compiles its readable nested source;
Vite delegates the configured CSS transform and production minification to
Lightning CSS. `base: "./"` and `assetsInlineLimit: 0` keep the referenced
`accent-grid.svg` as a separate artifact and leave a relative URL in compiled
CSS. Pannonico resolves that URL against the hashed stylesheet before moving
matched declarations into `inlined.html`. The external pages let the browser
resolve the same URL from the published stylesheet.

Vite writes a hashed bundle, compiled CSS, SVG, and
`.pannonico/vite/.vite/manifest.json`. Pannonico maps the manifest's
`src/app.ts` entry to the `app` alias used by `partials/vite.html`, then renders
the HTML and Markdown pages through `layouts/default.html`. It separately maps
`src/accent-grid.svg` to the `accentGrid` resource alias, whose preload tag is
site-owned. The compiled CSS and SVG remain published because the external
pages still use them even though the inlined page consumes its selected
production link.

Development keeps Vite and Pannonico on separate loopback origins. The Vite
configuration allows only the default Pannonico origin, publishes its exact
origin, and uses a fixed strict port. Change the CORS origin together with the
Pannonico `watch --port` value when using another local port; do not replace it
with unrestricted CORS.

Generated Vite state and `dist*` site output are ignored. Do not commit them or
add a second lockfile under this workspace.
