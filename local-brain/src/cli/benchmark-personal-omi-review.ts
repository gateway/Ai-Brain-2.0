import { runPersonalOmiReviewCli } from "../benchmark/personal-omi-review.js";

runPersonalOmiReviewCli().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
