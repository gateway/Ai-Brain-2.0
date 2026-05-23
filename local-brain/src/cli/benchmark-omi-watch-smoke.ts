import { runOmiWatchSmokeBenchmarkCli } from "../benchmark/omi-watch-smoke.js";

runOmiWatchSmokeBenchmarkCli()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
