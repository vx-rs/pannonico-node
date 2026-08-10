---
title: Demo workflow
inlineCSS: false
---

<main class="demo-shell">

# One manifest, two runtimes

Vite transpiles the TypeScript entry and compiles its imported SCSS. Pannonico
then reads Vite's manifest and renders the same template under its native and
WASI runtimes. The HTML examples choose whether that production stylesheet is
kept as a link or selected for Pro inlining through ordinary page data.

[Return to the demo](/)

</main>
