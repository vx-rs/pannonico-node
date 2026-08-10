import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WASI } from "node:wasi";

// Constants
// -----------------------------------------------------------------------------

const GUEST_PROJECT = "/project";
const VALUE_OPTIONS = new Set([
  "--config",
  "--pages",
  "--layouts",
  "--partials",
  "--data",
  "--out",
  "--default-layout",
  "--default-language",
  "--html-validation",
  "--report-json",
  "--jobs",
]);
const PATH_OPTIONS = new Set([
  "--config",
  "--pages",
  "--layouts",
  "--partials",
  "--data",
  "--out",
  "--report-json",
]);
const BUILD_FLAGS = new Set([
  "--beautify",
  "--dry-run",
  "--minify",
  "--quiet",
  "--verbose",
  "--no-color",
  "--help",
]);
const SCAFFOLD_FLAGS = new Set(["--empty", "--force", "--vite", "--help"]);

// Invocation preparation
// -----------------------------------------------------------------------------

/**
 * prepareWasiInvocation converts one supported CLI invocation into a confined guest contract.
 *
 * Informational commands receive no filesystem. Build and scaffold receive exactly one real,
 * non-root, non-symlink project directory at `/project`; supported absolute options are translated
 * into that guest tree. Unknown options, extra roots, and escaping paths reject before WASI starts.
 */
export const prepareWasiInvocation = async (rawArguments, options = {}) => {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const args = [...rawArguments];
  const command = args[0];
  const env =
    typeof environment.SOURCE_DATE_EPOCH === "string"
      ? { SOURCE_DATE_EPOCH: environment.SOURCE_DATE_EPOCH }
      : {};
  if (!command || !["build", "scaffold"].includes(command) || hasHelp(args.slice(1))) {
    return { args, env, preopens: {} };
  }

  const parsed = parseProjectCommand(command, args.slice(1));
  const selected = path.resolve(cwd, parsed.root ?? ".");
  if (selected === path.parse(selected).root) {
    throw new Error(`refusing to preopen filesystem root ${JSON.stringify(selected)}`);
  }
  if (command === "scaffold") {
    await (options.mkdir ?? mkdir)(selected, {
      recursive: true,
    });
  }
  const realRoot = await (options.realpath ?? realpath)(selected);
  if (path.relative(selected, realRoot) !== "") {
    throw new Error(`WASI project root ${JSON.stringify(selected)} contains a symlink`);
  }
  if (realRoot === path.parse(realRoot).root) {
    throw new Error(`refusing to preopen filesystem root ${JSON.stringify(realRoot)}`);
  }
  const information = await (options.stat ?? stat)(realRoot);
  if (!information.isDirectory()) {
    throw new Error(`WASI project root ${JSON.stringify(selected)} is not a directory`);
  }

  const guestArguments = [command];
  for (const token of parsed.tokens) {
    if (typeof token === "string") {
      guestArguments.push(token);
      continue;
    }
    guestArguments.push(token.name, translatePath(token.value, realRoot));
  }
  guestArguments.push(GUEST_PROJECT);
  return { args: guestArguments, env, preopens: { [GUEST_PROJECT]: realRoot } };
};

// Execution
// -----------------------------------------------------------------------------

/**
 * runWasiExecutable starts one locally validated preview1 artifact with confined host access.
 *
 * The launcher validates the fixed path as a regular non-symlink file before calling this boundary.
 * This function reads and compiles those bytes, inherits the selected streams, exposes only the
 * prepared project and approved environment, and returns the guest's exact exit status.
 */
export const runWasiExecutable = async (modulePath, rawArguments, options = {}) => {
  const invocation = await prepareWasiInvocation(rawArguments, options);
  const Wasi = options.Wasi ?? WASI;
  const wasi = new Wasi({
    version: "preview1",
    args: ["pannonico", ...invocation.args],
    env: invocation.env,
    preopens: invocation.preopens,
    stdin: (options.stdin ?? process.stdin).fd,
    stdout: (options.stdout ?? process.stdout).fd,
    stderr: (options.stderr ?? process.stderr).fd,
    returnOnExit: true,
  });
  const bytes = await (options.readModule ?? readFile)(modulePath);
  const compile = options.compile ?? WebAssembly.compile;
  const instantiate = options.instantiate ?? WebAssembly.instantiate;
  const module = await compile(bytes);
  const instance = await instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  return wasi.start(instance);
};

// Argument parsing
// -----------------------------------------------------------------------------

/** hasHelp detects command help forms that must not require a project preopen. */
const hasHelp = (args) =>
  args.includes("--help") || args.includes("--help=true") || args.includes("-h");

/**
 * parseProjectCommand separates one project root from the supported guest-visible options.
 *
 * It preserves option order for the Go CLI, marks path-valued options for later confinement, and
 * rejects syntax that the host cannot safely translate instead of forwarding it with broader access.
 */
const parseProjectCommand = (command, args) => {
  const tokens = [];
  let root;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      const positional = args.slice(index + 1);
      if (root !== undefined || positional.length > 1) {
        throw new Error(`${command} accepts at most one project root`);
      }
      root = positional[0];
      break;
    }
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals < 0 ? argument : argument.slice(0, equals);
    if (command === "build" && VALUE_OPTIONS.has(name)) {
      const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
      if (typeof value !== "string" || value === "" || (equals < 0 && value.startsWith("-"))) {
        throw new Error(`option ${JSON.stringify(name)} requires a value`);
      }
      if (equals < 0) index += 1;
      tokens.push(
        PATH_OPTIONS.has(name) ? { name, value } : name,
        ...(PATH_OPTIONS.has(name) ? [] : [value]),
      );
    } else if (
      (command === "build" && BUILD_FLAGS.has(name)) ||
      (command === "scaffold" && SCAFFOLD_FLAGS.has(name))
    ) {
      tokens.push(argument);
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown ${command} option ${JSON.stringify(name)}`);
    } else if (root === undefined) {
      root = argument;
    } else {
      throw new Error(`${command} accepts at most one project root`);
    }
  }
  return { root, tokens };
};

/**
 * translatePath maps an absolute host option into the selected guest project tree.
 *
 * Relative values already resolve inside the guest working project and remain unchanged. Absolute
 * values must resolve at or below the real preopen root; an escape rejects before module execution.
 */
const translatePath = (value, root) => {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(root, path.resolve(value));
  if (isContainedPath(relative)) {
    return relative === ""
      ? GUEST_PROJECT
      : `${GUEST_PROJECT}/${relative.split(path.sep).join("/")}`;
  }
  throw new Error(`path ${JSON.stringify(value)} is outside the WASI project root`);
};

/**
 * isContainedPath distinguishes a contained relative path from parent traversal or another root.
 *
 * Dot-prefixed file names remain valid. The exact parent and parent-prefixed paths are rejected so
 * translatePath cannot construct a guest path outside `/project` on either path separator style.
 */
const isContainedPath = (value) =>
  value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
