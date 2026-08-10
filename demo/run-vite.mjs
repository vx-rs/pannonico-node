// Vite runner
// -----------------------------------------------------------------------------

// Resolve Vite from this workspace package and import its CLI in the current
// Node process. Pannonico then owns the real development process on every host,
// including Windows, instead of owning a short-lived npm command shim.
const vitePackageURL = import.meta.resolve("vite/package.json");
const viteCLIURL = new URL("bin/vite.js", vitePackageURL);

await import(viteCLIURL.href);
