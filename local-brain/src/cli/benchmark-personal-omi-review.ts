import { runPersonalOmiReviewCli } from "../benchmark/personal-omi-review.js";

runPersonalOmiReviewCli()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
  console.error(error);
    process.exit(1);
  });
