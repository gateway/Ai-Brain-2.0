import { runNaturalQuerySourceGapCoverageCli } from "../benchmark/natural-query-source-gap-coverage.js";

runNaturalQuerySourceGapCoverageCli()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
