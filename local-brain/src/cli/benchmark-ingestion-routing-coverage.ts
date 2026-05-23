import { runIngestionRoutingCoverageCli } from "../benchmark/ingestion-routing-coverage.js";

runIngestionRoutingCoverageCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
