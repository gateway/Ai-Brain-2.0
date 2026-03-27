import { runNaturalQueryReviewBenchmarkCli } from "../benchmark/natural-query-review.js";

runNaturalQueryReviewBenchmarkCli()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
