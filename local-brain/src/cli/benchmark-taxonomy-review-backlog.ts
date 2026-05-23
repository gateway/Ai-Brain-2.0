import { runTaxonomyReviewBacklogCli } from "../benchmark/taxonomy-review-backlog.js";

runTaxonomyReviewBacklogCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
