import { runCanonicalIdentityReviewCli } from "../benchmark/canonical-identity-review.js";

runCanonicalIdentityReviewCli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
