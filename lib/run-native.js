import { spawn } from "node:child_process";

/** runNativeExecutable starts one verified binary with the caller's process boundary. */
export const runNativeExecutable = (executable, argumentsToForward, options = {}) => {
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, argumentsToForward, {
      cwd: options.cwd ?? process.cwd(),
      env: options.environment ?? process.env,
      stdio: "inherit",
    });
    let finished = false;
    child.once("error", (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
    child.once("exit", (status, signal) => {
      if (!finished) {
        finished = true;
        resolve({ signal, status: status ?? 1 });
      }
    });
  });
};
