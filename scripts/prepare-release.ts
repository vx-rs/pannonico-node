import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { updateReleaseFiles } from "./release-package.ts";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** prepareRelease synchronizes one exact wrapper version for a controlled publication job. */
export const prepareRelease = (version, root = REPOSITORY_ROOT) =>
  updateReleaseFiles(root, version);

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    prepareRelease(process.argv[2] ?? "");
  } catch (error) {
    console.error(`Release preparation failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
