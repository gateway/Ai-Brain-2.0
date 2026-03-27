import { runQueryTimeHealingReviewBenchmarkCli } from "../benchmark/query-time-healing-review.js";

runQueryTimeHealingReviewBenchmarkCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
