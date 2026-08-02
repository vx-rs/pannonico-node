/** createDebugLogger returns an opt-in, stderr-only launcher diagnostic writer. */
export const createDebugLogger = (environment = process.env, stderr = process.stderr) => {
  const enabled = environment.PANNONICO_LAUNCHER_DEBUG === "1";
  return (message) => {
    if (enabled) stderr.write(`[pannonico launcher] ${message}\n`);
  };
};
