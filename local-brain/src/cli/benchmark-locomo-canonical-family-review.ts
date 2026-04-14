import { runLoCoMoCanonicalFamilyReviewCli } from "../benchmark/locomo-canonical-family-review.js";

runLoCoMoCanonicalFamilyReviewCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
