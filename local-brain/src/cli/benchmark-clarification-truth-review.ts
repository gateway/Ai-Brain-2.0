import { runClarificationTruthReviewBenchmarkCli } from "../benchmark/clarification-truth-review.js";

runClarificationTruthReviewBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
