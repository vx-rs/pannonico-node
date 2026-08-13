# Pannonico local launcher

`@vx.rs/pannonico` is a private prototype launcher for locally built Pannonico
binaries. It runs a native binary when one is available for the current host
and otherwise uses the local WASI build. It does not download artifacts,
resolve platform packages, or publish anything.

## Local development

Build one edition in the sibling Go repository:

```sh
cd ../pannonico-go
mkdir -p build/free/native
CGO_ENABLED=0 go build -mod=vendor -trimpath \
  -o build/free/native/pannonico ./cmd/pannonico
CGO_ENABLED=0 GOOS=wasip1 GOARCH=wasm go build -mod=vendor -trimpath \
  -o build/free/pannonico.wasm ./cmd/pannonico
```

Copy that edition into this launcher's fixed artifact paths:

```sh
cd ../pannonico-node
mkdir -p artifacts/native
cp ../pannonico-go/build/free/native/pannonico artifacts/native/pannonico
cp ../pannonico-go/build/free/pannonico.wasm artifacts/pannonico.wasm
```

Use `build/pro/...` instead to test the Pro edition. On Windows, name the
native artifact `artifacts/native/pannonico.exe`. Always replace the native and
WASI files together. Mixing a Free artifact with a Pro artifact can make native
and fallback execution report different capabilities.

Install the development tools, run the launcher tests, and create the global
development link:

```sh
npm ci --ignore-scripts
npm test
npm link
```

Then link it into a Vite or other consumer project:

```sh
cd ../my-project
npm link @vx.rs/pannonico
npx pannonico --version
```

Run `npm unlink @vx.rs/pannonico` in the consumer when the local test is done.

The sibling
`../pannonico-go/docs/local-development.md` document is the canonical workflow
for complete Go checks, Free/Pro artifact builds, Vite parity, Pro watch, and
private Git snapshot testing.

## Internal Vite demo

The private `demo` npm workspace is a comprehensive integration fixture, not
the minimum fresh-project setup. It is a complete local consumer that keeps its
Vite, Sass, Lightning CSS, and TypeScript dependencies separate from the
launcher package. One root install prepares both packages:

```sh
npm ci --ignore-scripts
npm run demo:typecheck
npm run demo:assets
```

`demo:typecheck` and `demo:assets` do not require Pannonico artifacts. After
copying a matched Pro native/WASI pair as described above, exercise the real
connector and its Pro-only readable HTML mode:

```sh
npm run demo:build
npm run demo:verify
```

`demo:build` uses `pannonico build --beautify` with the native launcher artifact
and lets Pannonico run the configured Vite build. `demo:verify` first confirms
that both local artifacts advertise the Pro-only `css-inlining` and
`rich-markdown` capabilities. It
type-checks the TypeScript source, performs one beautified native build, reuses
that exact Vite manifest for a beautified forced-WASI build, and requires both
complete output trees to be byte-identical. It also verifies readable two-space
HTML nesting and both CSS policies from one shared Vite entry. `index.html` and
the Markdown guide retain the compiled stylesheet link without generated inline
CSS. The guide also verifies heading anchors, footnotes, abbreviations,
containers, subscript, superscript, marks, insertions, deletions, syntax token
classes, and one consolidated footnote group at the end of
`.pannonico.content`, before the layout footer. Its SCSS customizes the stable
container and code wrappers, generated container modifier, and scoped token
classes because Pannonico provides no default container or code theme.
`inlined.html` uses
`data-pannonico-inline-css`, contains generated style
attributes and residual media CSS, removes the selected link, and rebases the
SCSS asset URL. Every page retains the JavaScript tag, and all compiled CSS,
JavaScript, and SVG assets remain published. The site also renders a resource-
alias image preload whose tag policy stays in the demo template.

For a standalone fallback build, produce the manifest before forcing WASI;
the confined WASI runtime does not start Vite or another host process:

```sh
npm run demo:assets
PANNONICO_FORCE_WASI=1 npm run demo:build
```

With a Pro native artifact, start coordinated Pannonico and Vite development:

```sh
npm run demo:watch
```

The equivalent commands inside `demo/` are `npm run build` and `npm run watch`;
both pass `--beautify`. The complete demo therefore requires Pro native and Pro
WASI artifacts with `css-inlining` and `rich-markdown`, while only the native artifact provides
watch mode. CSS inlining has no project setting or CLI flag: the shared partial
marks the production link only for the page whose ordinary `inlineCSS`
frontmatter is true. Development links remain unmarked so Vite owns CSS HMR.
Demo dependencies, Vite state, and `dist*` output remain local and are not
included by the launcher's `files` package boundary. See
[`demo/README.md`](demo/README.md) for the source-to-manifest data flow.

## WASI fallback

Set `PANNONICO_FORCE_WASI=1` to exercise the portable runtime explicitly:

```sh
PANNONICO_FORCE_WASI=1 npx pannonico build site
PANNONICO_FORCE_WASI=1 npx pannonico build article.md --out dist
```

For a positional file, the host preopens only its real parent and forwards the
guest file identity below `/project`. For a directory, it preopens that selected
project at `/project`. It forwards only
`SOURCE_DATE_EPOCH`, and preserves standard streams and exit status. Absolute
and relative path options must remain inside that one preopen. `--data` works
only within it. The host recognizes repeated `--data-url` syntax but both WASI
editions reject the Pro-native-only capability. Native-only commands and
configured remote data are reported by Pannonico with exit status `4`.

`PANNONICO_FORCE_WASI=1 npx pannonico scaffold --min site` creates the same
config-only starter as the native command.

The launcher falls back when the native artifact is absent or the host is not
supported. A symlink, non-file, or non-executable native artifact is treated as
an error. Set `PANNONICO_LAUNCHER_DEBUG=1` for safe host, selection, and fallback
diagnostics on standard error.

## Private Git dependency

A consumer may pin this repository directly during the prototype phase:

```json
{
  "devDependencies": {
    "@vx.rs/pannonico": "git+ssh://git@github.com/vx-rs/pannonico-node.git#<commit>"
  }
}
```

Git dependencies are immutable snapshots, not live sibling checkouts. The
selected native and WASI artifacts must be committed in that private snapshot
if another machine or CI job needs them. Because ordinary artifact copies are
ignored, create such a snapshot deliberately after copying one matched pair:

```sh
git add -f artifacts/native/pannonico artifacts/pannonico.wasm
git commit -m "chore: snapshot local Pannonico artifacts"
git rev-parse HEAD
```

Use `artifacts/native/pannonico.exe` in the first command for a Windows-native
snapshot. Pin the commit printed by the final command in the consumer's
`package.json`. Do not pin the preceding source-only commit because it does not
contain the ignored artifacts.

There is deliberately no `prepare` script, generated package graph, registry
release, or install-time download. For normal same-machine development,
`npm link` is the shorter feedback loop and artifacts remain untracked.
