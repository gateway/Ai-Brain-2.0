import { runNoteReconsolidationReviewBenchmarkCli } from "../benchmark/note-reconsolidation-review.js";

runNoteReconsolidationReviewBenchmarkCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
