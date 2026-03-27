import { runOmiWatchSmokeBenchmarkCli } from "../benchmark/omi-watch-smoke.js";

runOmiWatchSmokeBenchmarkCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
