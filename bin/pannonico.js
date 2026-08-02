#!/usr/bin/env node

import { main } from "../lib/launcher.js";

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    console.error(`Pannonico launcher failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  },
);
