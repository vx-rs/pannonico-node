import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WASI } from "node:wasi";

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
const BUILD_FLAGS = new Set(["--dry-run", "--quiet", "--verbose", "--no-color", "--help"]);
const SCAFFOLD_FLAGS = new Set(["--empty", "--force", "--help"]);

/** prepareWasiInvocation confines filesystem commands to one selected project preopen. */
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

/** runWasiExecutable starts one verified preview1 module with inherited process streams. */
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

const hasHelp = (args) =>
  args.includes("--help") || args.includes("--help=true") || args.includes("-h");

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

/** isContainedPath accepts dot-prefixed names while rejecting an exact parent traversal. */
const isContainedPath = (value) =>
  value === "" || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
