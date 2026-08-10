import { spawn } from "node:child_process";

// Constants
// -----------------------------------------------------------------------------

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];

// Signal lifecycle
// -----------------------------------------------------------------------------

/**
 * subscribeToSignals gives the launcher ownership of termination signals before native startup.
 *
 * runNativeExecutable installs these listeners before spawning so a startup signal can be queued
 * until the isolated child exists. The returned callback removes every listener after either
 * spawn failure or exit so repeated invocations do not accumulate global process handlers.
 */
const subscribeToSignals = (forwardSignal, signalSource) => {
  const listeners = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => forwardSignal(signal);
    listeners.set(signal, listener);
    signalSource.on(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) signalSource.removeListener(signal, listener);
  };
};

// Public API
// -----------------------------------------------------------------------------

/**
 * runNativeExecutable starts one local binary with inherited streams and caller context.
 *
 * POSIX children use a separate process group so a terminal signal reaches the launcher only;
 * the listeners above then deliver it to the child exactly once. Windows keeps the default
 * process relationship because Node does not provide equivalent POSIX signal groups there.
 */
export const runNativeExecutable = (executable, argumentsToForward, options = {}) => {
  const spawnProcess = options.spawnProcess ?? spawn;
  return new Promise((resolve, reject) => {
    let child;
    const pendingSignals = [];
    const unsubscribe = subscribeToSignals((signal) => {
      if (child) child.kill(signal);
      else pendingSignals.push(signal);
    }, options.signalSource ?? process);
    try {
      child = spawnProcess(executable, argumentsToForward, {
        cwd: options.cwd ?? process.cwd(),
        detached: options.detached ?? process.platform !== "win32",
        env: options.environment ?? process.env,
        stdio: "inherit",
      });
    } catch (error) {
      unsubscribe();
      reject(error);
      return;
    }
    let finished = false;
    child.once("error", (error) => {
      if (!finished) {
        finished = true;
        unsubscribe();
        reject(error);
      }
    });
    child.once("exit", (status, signal) => {
      if (!finished) {
        finished = true;
        unsubscribe();
        resolve({ signal, status: status ?? 1 });
      }
    });
    for (const signal of pendingSignals) child.kill(signal);
  });
};
