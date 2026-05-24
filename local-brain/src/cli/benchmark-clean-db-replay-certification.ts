import { runCleanDbReplayCertificationCli } from "../benchmark/clean-db-replay-certification.js";

runCleanDbReplayCertificationCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
