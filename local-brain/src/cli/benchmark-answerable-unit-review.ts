import { runAnswerableUnitReviewBenchmark } from "../benchmark/answerable-unit-review.js";

runAnswerableUnitReviewBenchmark()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
