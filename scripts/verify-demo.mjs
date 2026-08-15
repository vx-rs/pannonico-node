// Imports
// -----------------------------------------------------------------------------
// Node.js
import { spawn } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Paths and package boundary
// -----------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEMO_ROOT = join(ROOT, "demo");
const DEMO_PACKAGE_URL = new URL("../demo/package.json", import.meta.url);
const demoRequire = createRequire(DEMO_PACKAGE_URL);

/**
 * resolveLauncher resolves the Pannonico bin declared by the demo package's launcher dependency.
 *
 * The returned paths are independent of npm's hoisted or nested workspace layout. Invalid package
 * metadata and an unresolved dependency reject before any child process or output mutation begins.
 */
const resolveLauncher = async () => {
  let packageJSONPath;
  try {
    packageJSONPath = demoRequire.resolve("@vx.rs/pannonico/package.json");
  } catch (error) {
    throw new Error("The demo launcher dependency is missing. Run npm ci at the repository root.", {
      cause: error,
    });
  }
  const packageRoot = dirname(packageJSONPath);
  const metadata = JSON.parse(await readFile(packageJSONPath, "utf8"));
  const binPath = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pannonico;
  if (typeof binPath !== "string" || binPath === "") {
    throw new Error("The resolved @vx.rs/pannonico package does not declare its pannonico bin.");
  }
  return { launcherPath: join(packageRoot, binPath), packageRoot };
};

/**
 * resolveDemoDependency confirms that one frontend package request resolves for the demo workspace.
 *
 * It returns the resolved file and converts resolution failures into the one root installation
 * command developers need. The optional request supports packages that do not export metadata.
 */
const resolveDemoDependency = (packageName, request = `${packageName}/package.json`) => {
  try {
    return demoRequire.resolve(request);
  } catch (error) {
    throw new Error(
      `The demo dependency ${JSON.stringify(packageName)} is missing. Run npm ci at the repository root.`,
      { cause: error },
    );
  }
};

// Process execution
// -----------------------------------------------------------------------------

/**
 * runCommand starts one verification child with inherited streams and the supplied environment.
 *
 * The promise resolves only for exit status zero. Spawn errors, signals, and non-zero statuses
 * reject with the operation label so the verifier cannot continue with stale generated output.
 */
const runCommand = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: "inherit",
    });
    let finished = false;
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      reject(new Error(`${options.label} could not start`, { cause: error }));
    });
    child.once("exit", (status, signal) => {
      if (finished) return;
      finished = true;
      if (signal) {
        reject(new Error(`${options.label} stopped after ${signal}`));
      } else if (status !== 0) {
        reject(new Error(`${options.label} exited with status ${status}`));
      } else {
        resolve();
      }
    });
  });

/**
 * runCommandOutput executes one prerequisite command and returns its UTF-8 standard output.
 *
 * Capability checks use captured streams because their content determines whether the selected
 * artifact may build this Pro-only demo. A spawn error, signal, or non-zero status rejects before
 * Vite or Pannonico can mutate generated directories.
 */
const runCommandOutput = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let finished = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      reject(new Error(`${options.label} could not start`, { cause: error }));
    });
    child.once("exit", (status, signal) => {
      if (finished) return;
      finished = true;
      if (signal) {
        reject(new Error(`${options.label} stopped after ${signal}`));
      } else if (status !== 0) {
        reject(
          new Error(
            `${options.label} exited with status ${status}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      } else {
        resolve(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });

// Output inspection
// -----------------------------------------------------------------------------

/**
 * walkOutputTree records every regular file below one generated output directory.
 *
 * Relative keys always use forward slashes for cross-platform comparison. Directories recurse;
 * symlinks and special files reject so byte parity cannot hide an unsafe or unexamined entry.
 */
const walkOutputTree = async (root, relativeDirectory, files) => {
  const directory = join(root, ...relativeDirectory.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkOutputTree(root, relativePath, files);
    } else if (entry.isFile()) {
      files.set(relativePath, await readFile(absolutePath));
    } else {
      throw new Error(`Generated output contains a non-regular entry: ${absolutePath}`);
    }
  }
};

/**
 * readOutputTree returns a relative-path-to-bytes map for one completed Pannonico build.
 *
 * Missing or unreadable output rejects. The helper has no writes and delegates special-file
 * rejection to walkOutputTree.
 */
const readOutputTree = async (root) => {
  const files = new Map();
  await walkOutputTree(root, "", files);
  return files;
};

/**
 * compareOutputTrees requires two generated trees to contain the same paths and exact bytes.
 *
 * A missing, extra, or changed file rejects with its relative path. The input maps remain
 * unchanged, allowing later manifest assertions to inspect the verified native tree.
 */
const compareOutputTrees = (nativeFiles, wasiFiles) => {
  const nativePaths = [...nativeFiles.keys()];
  const wasiPaths = [...wasiFiles.keys()];
  if (JSON.stringify(nativePaths) !== JSON.stringify(wasiPaths)) {
    throw new Error(
      `Native and WASI output paths differ:\nnative: ${nativePaths.join(", ")}\nwasi: ${wasiPaths.join(", ")}`,
    );
  }
  for (const relativePath of nativePaths) {
    if (!nativeFiles.get(relativePath).equals(wasiFiles.get(relativePath))) {
      throw new Error(`Native and WASI output bytes differ for ${relativePath}`);
    }
  }
};

/**
 * verifySitemap requires the demo's complete deterministic sitemap bytes.
 *
 * Tree parity has already proved the native and WASI files match, so checking the native map
 * covers both runtimes while fixing the expected base URL, route mapping, order, and XML format.
 */
const verifySitemap = (files) => {
  const expected = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/pannonico-node-demo/</loc>
  </url>
  <url>
    <loc>https://example.com/pannonico-node-demo/guide.html</loc>
  </url>
  <url>
    <loc>https://example.com/pannonico-node-demo/inlined.html</loc>
  </url>
</urlset>
`;
  const sitemap = files.get("sitemap.xml")?.toString("utf8");
  if (sitemap !== expected) {
    throw new Error("sitemap.xml does not contain the configured three-route sitemap");
  }
};

/**
 * verifyReadableHTML requires the demo's generated documents to follow Pro's fixed formatting.
 *
 * All pages must have top-level document lines, two-space head/body nesting, deeper main content,
 * LF-only output, and no final newline. It reads the parity-checked map without changing files.
 */
const verifyReadableHTML = (files) => {
  for (const page of ["index.html", "inlined.html", "guide.html"]) {
    const html = files.get(page)?.toString("utf8");
    if (!html) throw new Error(`Rendered demo page is missing: ${page}`);
    const lines = html.split("\n");
    const hasDocumentNesting =
      lines[0] === "<!doctype html>" &&
      lines[1]?.startsWith('<html lang="en"') &&
      lines.some((line) => line.startsWith("  <head")) &&
      lines.some((line) => line.startsWith("  <body")) &&
      lines.some((line) => line.startsWith("    <main")) &&
      lines.at(-1) === "</html>";
    if (
      !hasDocumentNesting ||
      html.includes("\r") ||
      html.endsWith("\n") ||
      lines.some((line) => line.startsWith("\t"))
    ) {
      throw new Error(`${page} does not follow the fixed readable HTML output policy`);
    }
  }
};

/**
 * verifyRichMarkdown requires all ten Pro plugins in the shared native/WASI guide output.
 *
 * The complete output trees have already passed byte parity, so one guide check covers both
 * runtime targets while still naming the missing semantic element in a focused failure.
 */
const verifyRichMarkdown = (files) => {
  const html = files.get("guide.html")?.toString("utf8");
  if (!html) throw new Error("Rendered rich-Markdown guide is missing");
  for (const expected of [
    'id="one-manifest-two-runtimes"',
    '<abbr title="Hyper Text Markup Language">HTML</abbr>',
    "H<sub>2</sub>O",
    "29<sup>th</sup>",
    "<mark>highlighted text</mark>",
    "<ins>inserted text</ins>",
    "<del>deleted text</del>",
    'class="pannonico-container pannonico-container--build-note"',
    '<pre class="pannonico-code"><code>const answer: number = 42',
    'class="pannonico-code"',
    'class="language-ts"',
    'class="line"',
    'class="cl"',
    'class="kr">const</span>',
    'class="kt">number</span>',
    'class="mi">42</span>',
    'class="footnote-ref"',
    'class="footnotes-list"',
  ]) {
    if (!html.includes(expected)) {
      throw new Error(`guide.html lacks rich-Markdown output: ${expected}`);
    }
  }
  if (html.split('class="pannonico-code"').length !== 3) {
    throw new Error("guide.html does not contain exactly two fenced-code wrappers");
  }
  const footnoteGroup = html.lastIndexOf('class="footnotes"');
  const pageContentEnd = html.lastIndexOf("</main>");
  const layoutFooter = html.lastIndexOf("<footer>");
  if (
    html.split('class="footnotes"').length !== 2 ||
    footnoteGroup < pageContentEnd ||
    layoutFooter < footnoteGroup ||
    !html.includes('id="fn1"') ||
    !html.includes('id="fnref1-1"')
  ) {
    throw new Error(
      "guide.html does not contain one finalized footnote group between page content and layout output",
    );
  }
};

/**
 * readViteManifestContract loads records configured as Pannonico entry and resource aliases.
 *
 * It returns only a record with one JavaScript file, at least one CSS file, and an asset list.
 * Missing, malformed, or incompatible manifest data rejects before rendered-page assertions run.
 */
const readViteManifestContract = async () => {
  const manifestPath = join(DEMO_ROOT, ".pannonico", "vite", ".vite", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest["src/app.ts"];
  const resource = manifest["src/accent-grid.svg"];
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.file !== "string" ||
    !Array.isArray(entry.css) ||
    entry.css.length === 0 ||
    entry.css.some((file) => typeof file !== "string") ||
    !Array.isArray(entry.assets) ||
    entry.assets.some((file) => typeof file !== "string")
  ) {
    throw new Error("The Vite manifest does not contain the configured src/app.ts entry and CSS.");
  }
  if (!resource || typeof resource !== "object" || typeof resource.file !== "string") {
    throw new Error(
      "The Vite manifest does not contain the configured src/accent-grid.svg resource.",
    );
  }
  return { entry, resource };
};

/**
 * verifyPublishedAssets proves one shared Vite entry supports linked and inlined page policies.
 *
 * It reads only the already parity-checked native output map. Missing files, page-policy drift,
 * wrong URL rebasing, and missing TypeScript/SCSS markers reject with a focused integration error.
 */
const verifyPublishedAssets = (files, entry, resource) => {
  const pages = ["index.html", "inlined.html", "guide.html"];
  const assets = [...new Set([entry.file, ...entry.css, ...entry.assets, resource.file])];
  for (const asset of assets) {
    if (!files.has(asset)) throw new Error(`Manifest asset was not published: ${asset}`);
  }
  for (const page of pages) {
    const html = files.get(page)?.toString("utf8");
    if (!html) throw new Error(`Rendered demo page is missing: ${page}`);
    if (!html.includes(`/${entry.file}`)) {
      throw new Error(`${page} does not retain the Vite JavaScript entry`);
    }
    if (!html.includes(`rel="preload" as="image" href="/${resource.file}"`)) {
      throw new Error(`${page} does not render the configured Vite resource alias`);
    }
    if (html.includes("data-pannonico-inline-css")) {
      throw new Error(`${page} retains a Pannonico CSS marker`);
    }
  }

  for (const page of ["index.html", "guide.html"]) {
    const html = files.get(page).toString("utf8");
    for (const stylesheet of entry.css) {
      if (!html.includes(`href="/${stylesheet}"`)) {
        throw new Error(`${page} does not retain the external production stylesheet`);
      }
    }
    if (html.includes("style=") || html.includes("<style") || html.includes("@media")) {
      throw new Error(`${page} unexpectedly contains generated inline CSS`);
    }
  }

  const inlinedHTML = files.get("inlined.html").toString("utf8");
  for (const stylesheet of entry.css) {
    if (inlinedHTML.includes(`href="/${stylesheet}"`)) {
      throw new Error("inlined.html retains its selected production stylesheet link");
    }
  }
  if (!inlinedHTML.includes("style=") || !inlinedHTML.includes("@media")) {
    throw new Error("inlined.html lacks inlined declarations or residual media CSS");
  }
  const rebasedAsset = entry.assets.find((asset) => asset.includes("accent-grid"));
  if (!rebasedAsset || !inlinedHTML.includes(`url(&quot;/${rebasedAsset}&quot;)`)) {
    throw new Error("inlined.html lacks the root-relative inlined Vite asset URL");
  }

  const script = files.get(entry.file).toString("utf8");
  if (!script.includes("Pannonico demo TypeScript is active.")) {
    throw new Error("The published JavaScript does not contain the TypeScript demo marker.");
  }
  const compiledCSS = entry.css.map((file) => files.get(file).toString("utf8")).join("\n");
  if (!compiledCSS.includes("--pannonico-demo-accent")) {
    throw new Error("The published CSS does not contain the compiled SCSS demo marker.");
  }
  if (!/url\((?:["']?)\.\/[^)]*accent-grid/.test(compiledCSS)) {
    throw new Error("The compiled Vite CSS does not contain the relative asset URL fixture.");
  }
};

/**
 * requireDemoCapabilities checks both launcher selection paths before any demo build.
 *
 * A mixed or Free artifact pair receives one actionable copy instruction rather than failing
 * indirectly during native or forced-WASI rendering.
 */
const requireDemoCapabilities = async (launcherPath) => {
  const nativeEnvironment = { ...process.env };
  delete nativeEnvironment.PANNONICO_FORCE_WASI;
  for (const selection of [
    { label: "native", environment: nativeEnvironment },
    { label: "forced-WASI", environment: { ...process.env, PANNONICO_FORCE_WASI: "1" } },
  ]) {
    const output = await runCommandOutput(process.execPath, [launcherPath, "capabilities"], {
      cwd: ROOT,
      environment: selection.environment,
      label: `${selection.label} capability check`,
    });
    const capabilities = output.split("\n");
    for (const capability of ["css-inlining", "rich-markdown"]) {
      if (!capabilities.includes(`  - ${capability} (v1)`)) {
        throw new Error(
          `The ${selection.label} artifact lacks ${capability}. Copy a matched Pro native/WASI pair from pannonico-go.`,
        );
      }
    }
  }
};

// Verification workflow
// -----------------------------------------------------------------------------

/**
 * requireVerifiedArtifacts validates the demo's complete manifest-bound package pair.
 *
 * The verifier calls this before capability probes, TypeScript, Vite, or Pannonico builds. Loading
 * the API from the resolved package root preserves workspace/package-manager independence, while
 * package-time validation requires the manifest and both safe checksum-matched members. Any
 * validation failure becomes one concise Pro copy instruction without weakening the original cause.
 *
 * @param {string} packageRoot Resolved @vx.rs/pannonico package root.
 * @returns {Promise<void>} Resolves only when the manifest and both members validate.
 * @throws {Error} When package metadata or either bound artifact member is invalid or missing.
 */
const requireVerifiedArtifacts = async (packageRoot) => {
  const artifactModuleURL = pathToFileURL(join(packageRoot, "lib", "artifacts.js"));
  const { verifyPackageArtifacts } = await import(artifactModuleURL.href);
  try {
    await verifyPackageArtifacts(join(packageRoot, "artifacts"));
  } catch (error) {
    throw new Error(
      `A valid matched native/WASI pair is required. Run 'make copy-pro-node' in the sibling pannonico-go repository. ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
};

/**
 * verifyDemo runs the complete local workspace, native, WASI, and manifest integration contract.
 *
 * It validates the complete package pair before capabilities or build side effects, then requires
 * demo dependencies and Pro capabilities. It writes only ignored demo build directories and rejects
 * on the first failed prerequisite, command, parity, or asset assertion.
 */
const verifyDemo = async () => {
  const { launcherPath, packageRoot } = await resolveLauncher();
  if ((await realpath(packageRoot)) !== (await realpath(ROOT))) {
    throw new Error("The demo launcher dependency does not resolve to this repository root.");
  }

  await requireVerifiedArtifacts(packageRoot);

  resolveDemoDependency("vite");
  resolveDemoDependency("sass", "sass");
  resolveDemoDependency("lightningcss", "lightningcss");
  const typescriptPackage = resolveDemoDependency("typescript");

  await requireDemoCapabilities(launcherPath);

  const typescriptCLI = join(dirname(typescriptPackage), "bin", "tsc");
  await runCommand(
    process.execPath,
    [typescriptCLI, "--noEmit", "--project", join(DEMO_ROOT, "tsconfig.json")],
    {
      cwd: DEMO_ROOT,
      environment: process.env,
      label: "Demo TypeScript check",
    },
  );

  const nativeEnvironment = { ...process.env };
  delete nativeEnvironment.PANNONICO_FORCE_WASI;
  await runCommand(
    process.execPath,
    [launcherPath, "build", "--beautify", "--out", "dist-native", DEMO_ROOT],
    {
      cwd: ROOT,
      environment: nativeEnvironment,
      label: "Native demo build",
    },
  );
  await runCommand(
    process.execPath,
    [launcherPath, "build", "--beautify", "--out", "dist-wasi", DEMO_ROOT],
    {
      cwd: ROOT,
      environment: { ...process.env, PANNONICO_FORCE_WASI: "1" },
      label: "Forced-WASI demo build",
    },
  );

  const nativeFiles = await readOutputTree(join(DEMO_ROOT, "dist-native"));
  const wasiFiles = await readOutputTree(join(DEMO_ROOT, "dist-wasi"));
  compareOutputTrees(nativeFiles, wasiFiles);
  verifySitemap(nativeFiles);
  verifyReadableHTML(nativeFiles);
  verifyRichMarkdown(nativeFiles);
  const { entry, resource } = await readViteManifestContract();
  verifyPublishedAssets(nativeFiles, entry, resource);

  process.stdout.write(
    `Verified ${nativeFiles.size} byte-identical beautified native/WASI files, sitemap, and Vite manifest boundary.\n`,
  );
};

verifyDemo().catch((error) => {
  console.error(
    `Pannonico demo verification failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
