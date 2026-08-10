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
 * readViteEntry loads and validates the manifest record configured as Pannonico's app alias.
 *
 * It returns only a record with one JavaScript file and at least one CSS file. Missing, malformed,
 * or incompatible manifest data rejects before rendered-page assertions run.
 */
const readViteEntry = async () => {
  const manifestPath = join(DEMO_ROOT, ".pannonico", "vite", ".vite", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest["src/app.ts"];
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.file !== "string" ||
    !Array.isArray(entry.css) ||
    entry.css.length === 0 ||
    entry.css.some((file) => typeof file !== "string")
  ) {
    throw new Error("The Vite manifest does not contain the configured src/app.ts entry and CSS.");
  }
  return entry;
};

/**
 * verifyPublishedAssets proves the manifest entry reached both templates and compiled bundles.
 *
 * It reads only the already parity-checked native output map. Missing pages, absent public URLs,
 * unpublished assets, or missing TypeScript/SCSS markers reject with a focused integration error.
 */
const verifyPublishedAssets = (files, entry) => {
  const pages = ["index.html", "guide.html"];
  const assets = [entry.file, ...entry.css];
  for (const asset of assets) {
    if (!files.has(asset)) throw new Error(`Manifest asset was not published: ${asset}`);
  }
  for (const page of pages) {
    const html = files.get(page)?.toString("utf8");
    if (!html) throw new Error(`Rendered demo page is missing: ${page}`);
    for (const asset of assets) {
      if (!html.includes(`/${asset}`)) {
        throw new Error(`${page} does not reference the manifest asset /${asset}`);
      }
    }
  }
  const script = files.get(entry.file).toString("utf8");
  if (!script.includes("Pannonico demo TypeScript is active.")) {
    throw new Error("The published JavaScript does not contain the TypeScript demo marker.");
  }
  const compiledCSS = entry.css.map((file) => files.get(file).toString("utf8")).join("\n");
  if (!compiledCSS.includes("--pannonico-demo-accent")) {
    throw new Error("The published CSS does not contain the compiled SCSS demo marker.");
  }
};

// Verification workflow
// -----------------------------------------------------------------------------

/**
 * verifyDemo runs the complete local workspace, native, WASI, and manifest integration contract.
 *
 * It requires dependencies plus a matched local artifact pair, writes only ignored demo build
 * directories, and rejects on the first failed prerequisite, command, parity, or asset assertion.
 */
const verifyDemo = async () => {
  const { launcherPath, packageRoot } = await resolveLauncher();
  if ((await realpath(packageRoot)) !== (await realpath(ROOT))) {
    throw new Error("The demo launcher dependency does not resolve to this repository root.");
  }

  resolveDemoDependency("vite");
  resolveDemoDependency("sass", "sass");
  const typescriptPackage = resolveDemoDependency("typescript");

  const artifactModuleURL = pathToFileURL(join(packageRoot, "lib", "artifacts.js"));
  const { getArtifactPaths, inspectArtifact } = await import(artifactModuleURL.href);
  const artifactPaths = getArtifactPaths();
  const nativeAvailable = inspectArtifact(artifactPaths.native, "local native artifact", {
    executable: true,
    platform: process.platform,
  });
  const wasiAvailable = inspectArtifact(artifactPaths.wasi, "local WASI artifact", {
    platform: process.platform,
  });
  if (!nativeAvailable || !wasiAvailable) {
    throw new Error(
      "A matched native/WASI pair is required. Copy both artifacts from one pannonico-go build into artifacts/.",
    );
  }

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
  await runCommand(process.execPath, [launcherPath, "build", "--out", "dist-native", DEMO_ROOT], {
    cwd: ROOT,
    environment: nativeEnvironment,
    label: "Native demo build",
  });
  await runCommand(process.execPath, [launcherPath, "build", "--out", "dist-wasi", DEMO_ROOT], {
    cwd: ROOT,
    environment: { ...process.env, PANNONICO_FORCE_WASI: "1" },
    label: "Forced-WASI demo build",
  });

  const nativeFiles = await readOutputTree(join(DEMO_ROOT, "dist-native"));
  const wasiFiles = await readOutputTree(join(DEMO_ROOT, "dist-wasi"));
  compareOutputTrees(nativeFiles, wasiFiles);
  verifyPublishedAssets(nativeFiles, await readViteEntry());

  process.stdout.write(
    `Verified ${nativeFiles.size} byte-identical native/WASI files and the Vite manifest boundary.\n`,
  );
};

verifyDemo().catch((error) => {
  console.error(
    `Pannonico demo verification failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
