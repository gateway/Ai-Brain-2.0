import { runPersonalOpenClawReviewBenchmarkCli } from "../benchmark/personal-openclaw-review.js";

runPersonalOpenClawReviewBenchmarkCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
